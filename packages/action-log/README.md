# @codecaine-ai/action-log

One shared, append-only log of every MCP tool call on a machine. It replaces
the traces the kernel agents kept. The three surface servers (canvas-mcp,
docs-mcp, prompt-kit-mcp) append to it, Observatory ingests it, and queries
are SQL. The log stores who acted, with which tool, on which target, with what
result. It never stores a request body, a token or a payload.

## Path

One SQLite file per machine: `~/.codecaine/action-log.sqlite`. The folder is
created on first open. `CODECAINE_ACTION_LOG` overrides the path, for tests
and for reading a copied file. The file runs in WAL mode with a 5 second busy
timeout, so three daemons and several stdio bridges append at once without
losing a record. The switch to WAL on a fresh file is the one statement SQLite
refuses with `SQLITE_BUSY` instead of waiting, so `open()` retries it for the
same window.

## Identity rule

A record always carries a **run id** and carries a **thread id** when the
process knows one.

- **Run id.** Each server process mints one with `newRunId()` at start and
  keeps it for its life. canvas-mcp is the server process. docs-mcp and
  prompt-kit-mcp mint it in the stdio bridge (`cli.ts mcp`), which forwards it
  with each `/rpc` call to the shared daemon that writes the record.
- **Thread id from the environment.** Claude Code under T3 Code exports
  `T3CODE_THREAD_ID` to every MCP server it starts, and `AI_AGENT` names the
  harness. `identityFromEnv()` reads both. Codex scrubs the environment of
  the servers it starts, so under Codex both are null.
- **Thread id from the begin tool.** When the process has no thread id, the
  agent passes its T3 thread id to the surface's begin tool (`canvas_open`,
  `docs_begin`, `prompts_begin`), and the server calls
  `bindThread(runId, threadId)`. Every record of that run, written before or
  after the bind, then resolves to that thread. The first binding wins and
  later calls are no-ops.
- **A new identity source needs no schema change.** It sets `thread_id` on
  the record or binds the run. Nothing else moves.

Evidence, captured with `ps eww` on command-center on 2026-11-01:

| Harness | Parent of the MCP process | Environment the server sees |
|---|---|---|
| Claude Code in a T3 thread | `claude --output-format stream-json ...` | `T3CODE_THREAD_ID`, `CLAUDE_CODE_SESSION_ID`, `AI_AGENT`, `CLAUDE_PROJECT_DIR` and the shell's variables |
| Claude Code as a T3 delegated task | same | `T3CODE_THREAD_ID=thread:delegated-task:...`, the rest as above |
| Codex in a T3 thread | one `codex app-server` for every thread | `HOME`, `LANG`, `LOGNAME`, `PATH`, `SHELL`, `TMPDIR`, `USER` and the `env` table from `servers.toml` only |

Codex starts a fresh set of servers per conversation, so one run id still maps
to one thread there. The thread id itself only arrives through the begin tool.

## Schema

Version 1. `migrate()` runs each entry once, claims the version inside a
`BEGIN IMMEDIATE` transaction, and records it in `migrations`, so two
processes opening a new file at once apply it once.

```sql
CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,      -- the server process that served the call
  thread_id TEXT,            -- set when the process knew its thread at write time
  agent TEXT NOT NULL,       -- AI_AGENT when set, else the server's own name
  tool TEXT NOT NULL,        -- the MCP tool name
  target TEXT NOT NULL,      -- board id, page path or prompt path
  result TEXT NOT NULL,      -- short outcome summary, cut at 500 characters
  snapshot_id TEXT,          -- guidance snapshot id the server served
  at TEXT NOT NULL           -- ISO 8601, UTC
);
CREATE INDEX records_thread ON records (thread_id, at);
CREATE INDEX records_target ON records (target, at);
CREATE INDEX records_run ON records (run_id, at);
CREATE INDEX records_at ON records (at);

CREATE TABLE run_threads (    -- a run's thread, bound at most once
  run_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  bound_at TEXT NOT NULL
);
CREATE INDEX run_threads_thread ON run_threads (thread_id);

CREATE VIEW actions AS        -- records with the thread resolved; query this
  SELECT r.id, r.run_id, COALESCE(r.thread_id, b.thread_id) AS thread_id,
         r.agent, r.tool, r.target, r.result, r.snapshot_id, r.at
  FROM records r LEFT JOIN run_threads b ON b.run_id = r.run_id;
```

The one-board query the Spec names, in SQL:

```sql
SELECT at, tool, result FROM actions
WHERE thread_id = 'f571f4c5-...' AND target = 'canvases/payments-flow'
ORDER BY at, id;
```

## API

```ts
import { bindThread, identityFromEnv, newRunId, openActionLog } from "@codecaine-ai/action-log";

const runId = newRunId();                     // once per process
const identity = identityFromEnv();           // { threadId, agent } or nulls
const log = openActionLog();                  // { path? } to override

log.record({
  runId,
  threadId: identity.threadId,                // optional
  agent: identity.agent ?? "canvas-mcp",
  tool: "place_shape",
  target: "canvases/payments-flow",
  result: "ok, 2 findings",                   // a summary, never a payload
  snapshotId: "a1b2c3",                       // optional
  at: new Date(),
});

log.bindThread(runId, threadIdFromBeginTool); // idempotent, first binding wins

log.query({ threadId });                      // StoredRecord[], oldest first
log.query({ target, since: "2026-11-01T00:00:00Z", until: new Date() });
log.query({ runId, limit: 100 });
```

`since` is inclusive and `until` is exclusive. Filters combine with AND.
Every `StoredRecord.threadId` is the resolved thread: the record's own, else
the run's binding, else null.

## CLI

```sh
bun packages/action-log/src/cli.ts query --thread <id>
bun packages/action-log/src/cli.ts query --target <path> --since <iso> [--until <iso>]
bun packages/action-log/src/cli.ts query --run <id> --limit 50 --json
bun packages/action-log/src/cli.ts query --path /tmp/copy.sqlite
```

One line per record, oldest first, tab-separated: time, thread, run, agent,
tool, target, result, snapshot. `-` marks an empty field. `--json` prints one
JSON object per line for ingest. A missing file exits 1 and creates nothing.

## Wiring (pull requests 15 to 17)

- **canvas-mcp.** Mint the run id at `mcp` start, read `identityFromEnv()`,
  open the log once, and record after each tool call. `canvas_open` takes an
  optional `thread_id` and calls `bindThread`.
- **docs-mcp and prompt-kit-mcp.** The bridge mints the run id and reads the
  environment, then sends both with each `/rpc` call. The daemon opens the log
  once and records with the ids the bridge sent. `docs_begin` and
  `prompts_begin` take an optional `thread_id` and bind it.
- **Dispatcher.** Its threads start on Claude Code, whose environment already
  carries the thread id. The first message adds the begin-tool instruction
  once the tools accept `thread_id`.

## Tests

`bun test` in this package. The suite stores records from two threads against
one board and reads each back by thread and both by target, spawns two
processes that append 500 records each into one file and counts 1000, binds a
run-only record to a thread after the fact, and drives the CLI as a process.
`bunx tsc --noEmit -p packages/action-log` typechecks it.
