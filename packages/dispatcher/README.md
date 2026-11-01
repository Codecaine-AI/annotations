# @codecaine-ai/dispatcher

Routes human requests filed in a docs studio into T3 Code threads. A request is
an `agent-request` annotation on a docs page. The dispatcher subscribes to
docs-server's change stream, finds or starts the T3 thread for that page, binds
the thread to the annotation, and sends the request as the thread's next turn.
No internal agent runs. The agent in the thread answers through the docs MCP
annotation tools, and its reply shows in the Lab.

## Inputs

| Input | Value |
|---|---|
| T3 project | `t3Project`: the repo that owns the pages. The knowledge base for Session pages. |
| Thread title | The page title from its doc, passed to `t3 thread start --title`. |
| First message | The skill to load (`docs-system`), the annotation id, the page path, the request body, and the instruction to reply through the docs MCP annotation tools with author `agent`. |
| Host | One launchd user agent on command-center, label `ai.codecaine.dispatcher`, beside the docs daemon. |
| Precondition | The T3 Code server is running. `t3 thread` acts on the running server and needs no token on the same host. |

## Config

Settings come from `~/.config/codecaine-dispatcher/config.json` (or the file
named by `DISPATCHER_CONFIG`). Each key has an environment variable that wins.

| Key | Env | Meaning | Default |
|---|---|---|---|
| `docsProject` | `DISPATCHER_DOCS_PROJECT` | Docs project id from `~/.local/state/codecaine-docs/projects.json`. | required unless `docsUrl` is set |
| `t3Project` | `DISPATCHER_T3_PROJECT` | T3 project: a path inside the repo, or a project id. | required |
| `logPath` | `DISPATCHER_LOG_PATH` | Log file. | stdout |
| `docsStateFile` | `DISPATCHER_DOCS_STATE_FILE` | Docs daemon state file with `url` and `token`. Read on every connect. | `~/.local/state/codecaine-docs/daemon.json` |
| `docsUrl` | `DISPATCHER_DOCS_URL` | Explicit project API base URL, used without a token. For tests and a bare `docs serve`. | unset |
| `t3Bin` | `DISPATCHER_T3_BIN` | The `t3` executable. | `t3` on PATH |
| `t3Provider`, `t3Model` | `DISPATCHER_T3_PROVIDER`, `DISPATCHER_T3_MODEL` | Provider instance id and model slug for new threads. Required when the T3 project has no default model. Set both or neither. | unset |

`config.example.json` holds the command-center values.

## Install

```sh
bun run launchd/install.sh      # or: sh launchd/install.sh
sh launchd/uninstall.sh
```

`install.sh` writes `~/Library/LaunchAgents/ai.codecaine.dispatcher.plist` with
this checkout's bun and package paths, puts `~/.t3/bin` on the agent's PATH,
loads it, and starts it. Rerun it after moving the checkout. Restart by hand
with `launchctl kickstart -k gui/$(id -u)/ai.codecaine.dispatcher`.

## How it decides

- **Which events.** Change events whose `annotation.intent` is `agent-request`
  and whose `change` is `created` or `replied`, from any actor but the
  dispatcher itself (`session_id` `dispatcher`).
- **What is pending.** Read from the annotation's own replies, so a restart
  needs no state file. Authors `agent` and `system` are machine replies, every
  other author is a person. With no dispatcher reply yet, an open request is
  new. With one, the human replies after the last machine reply are the
  follow-up.
- **Which thread.** The newest `thread` field among the page's annotations,
  when `t3 thread show` confirms it still exists. Else a project thread with
  the page's title from `t3 thread list`. Else `t3 thread start`.
- **What it writes.** The thread id into the annotation's `thread` field
  (`PUT /api/annotations/:id/thread`), and a `system` reply
  `Sent to T3 thread "<title>" (t3-thread://v1/<id>).` on the annotation.
- **Replay.** On every stream connect it scans every page for pending requests,
  because the stream has no replay.
- **Failure.** A failed dispatch is retried after 5 seconds. A dropped stream
  reconnects after 2 seconds and re-reads the daemon state file.

## Tests

```sh
bun test            # in packages/dispatcher
bun run typecheck
```

The tests run the real loop against an in-process docs-server double
(`test/fake-docs-server.ts`) and a fake `t3` on PATH (`test/bin/t3`) that
records calls and prints ids.
