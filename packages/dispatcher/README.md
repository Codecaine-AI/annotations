# @codecaine-ai/dispatcher

Routes human requests filed in a studio into T3 Code threads. A request is an
`agent-request` annotation on a docs page, a Canvas board or a Prompt Kit
prompt. The dispatcher subscribes to each surface's change stream, finds or
starts the T3 thread for that page, board or prompt, binds the thread to the
annotation, and sends the request as the thread's next turn. No internal agent
runs. The agent in the thread answers through that surface's MCP request tools,
and its reply shows in the studio.

## Inputs

Each surface is one source (`src/docs.ts`, `src/canvas.ts`, `src/prompt.ts`)
behind the `Source` interface in `src/source.ts`. The pending rule, the thread
lookup, the `t3` calls and the backoff are shared (`src/dispatcher.ts`).

| Input | Docs | Canvas | Prompt Kit |
|---|---|---|---|
| Stream | docs-server `GET /api/events` | Canvas Studio `GET /api/canvas-annotation-events` | Prompt service `GET /api/events` |
| Store | docs-server annotation routes | Studio file API, writes with `If-Match` | Prompt service annotation routes, bearer token |
| Startup scan | every page in `/api/tree` | every board in `/api/canvases` | every prompt `prompts_discover` finds in `promptWorkspace` |
| T3 project | `t3Project`: the repo that owns the pages | `canvasT3Project`: the canvas repo | `promptT3Project`: the prompt-kit repo |
| Thread title | the page title | the board title | the prompt title from the catalog |
| Skill | `docs-system` | `canvas` | `prompt-kit` |
| Agent answers with | `docs_annotation_reply`, `docs_annotation_resolve` | `reply_annotation`, `resolve_request` | `prompts_request_reply`, `prompts_request_resolve` |

- **First message.** The skill to load, the annotation id, the page, board or
  prompt, the request body, and the MCP tools to answer with.
- **Host.** One launchd user agent on command-center, label
  `ai.codecaine.dispatcher`, beside the docs daemon.
- **Precondition.** The T3 Code server is running. `t3 thread` acts on the
  running server and needs no token on the same host. A source whose server is
  down retries its connection with backoff and logs each failure.
- **Canvas scope.** Canvas Studio serves the standalone boards in its
  `canvases/` folder. A page sidecar board belongs to its page's repo and is not
  on this stream.

## Config

Settings come from `~/.config/codecaine-dispatcher/config.json` (or the file
named by `DISPATCHER_CONFIG`). Each key has an environment variable that wins.

| Key | Env | Meaning | Default |
|---|---|---|---|
| `surfaces` | `DISPATCHER_SURFACES` | The sources to run: a list or comma string of `docs`, `canvas`, `prompt`. | all three |
| `docsProject` | `DISPATCHER_DOCS_PROJECT` | Docs project id from `~/.local/state/codecaine-docs/projects.json`. | required for docs unless `docsUrl` is set |
| `t3Project` | `DISPATCHER_T3_PROJECT` | T3 project for docs pages: a path inside the repo, or a project id. | required for docs |
| `docsStateFile` | `DISPATCHER_DOCS_STATE_FILE` | Docs daemon state file with `url` and `token`. Read on every connect. | `~/.local/state/codecaine-docs/daemon.json` |
| `docsUrl` | `DISPATCHER_DOCS_URL` | Explicit project API base URL, used without a token. For tests and a bare `docs serve`. | unset |
| `canvasStudioUrl` | `DISPATCHER_CANVAS_STUDIO_URL` | Canvas Studio base URL. | `http://127.0.0.1:3999`, the studio's dev port |
| `canvasT3Project` | `DISPATCHER_CANVAS_T3_PROJECT` | T3 project for boards. | `~/workspace/codebases/codecaine/core/canvas` |
| `promptStateFile` | `DISPATCHER_PROMPT_STATE_FILE` | Prompt service state file with `url` and `token`. Read on every connect. The token is never logged. | `~/.local/state/codecaine-prompts/daemon.json` |
| `promptWorkspace` | `DISPATCHER_PROMPT_WORKSPACE` | The workspace whose prompt catalog is served, as Prompt Studio's `PROMPT_KIT_STUDIO_WORKSPACE`. Events for prompts outside it are skipped. | `~/workspace/codebases/codecaine/core/prompt-kit` |
| `promptT3Project` | `DISPATCHER_PROMPT_T3_PROJECT` | T3 project for prompts. | `~/workspace/codebases/codecaine/core/prompt-kit` |
| `logPath` | `DISPATCHER_LOG_PATH` | Log file. | stdout |
| `t3Bin` | `DISPATCHER_T3_BIN` | The `t3` executable. | `t3` on PATH |
| `t3Provider`, `t3Model` | `DISPATCHER_T3_PROVIDER`, `DISPATCHER_T3_MODEL` | Provider instance id and model slug for new threads. Required when a T3 project has no default model. Set both or neither. | unset |

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

- **Which events.** Annotation events whose intent is `agent-request` and whose
  change is `created` or `replied`, from any actor but the dispatcher itself
  (`session_id` or `actor` `dispatcher`). Canvas events carry no actor, so the
  dispatcher's own canvas writes come back and find nothing pending.
- **What is pending.** Read from the annotation's own replies, so a restart
  needs no state file. Authors `agent` and `system` are machine replies, every
  other author is a person. Each dispatcher marker names its delivery:
  `Delivery: reply <id>.` for the newest human reply it carried, or
  `Delivery: request.` for the body alone. The human replies after the last
  `Sent` marker's delivery are pending, whatever agent replies or later markers
  sit around them. With no marker yet, an open request is new and its text is
  the body plus any human replies so far.
- **Which thread.** The newest `thread` field among the page's, board's or
  prompt's annotations, when `t3 thread show` confirms it still exists. Else a
  thread in the surface's T3 project with the same title from
  `t3 thread list`. Else `t3 thread start`.
- **What it writes, in order.** First a `system` reply
  `Sending to T3 thread "<title>" (t3-thread://v1/<id>). Delivery: ...` (or
  `Sending to T3 as a new thread "<title>". ...`), then the T3 call, then the
  thread id into the annotation's `thread` field, then the `system` reply
  `Sent to T3 thread "<title>" (t3-thread://v1/<id>). Delivery: ...`. The
  `Sending` marker goes down before the T3 call so a restart can tell that a
  delivery was handed to T3 and finish only the studio writes. A `Sending`
  marker with no `Sent` after it is completed on restart without a second
  turn, with a note on the `Sent` marker, except for a new thread that T3 does
  not list: that start never happened and runs now. Every surface gets the
  same two markers through its own reply write: the reply route on docs and
  Prompt Kit, and a board save on canvas. Canvas has no reply route, so the
  dispatcher reads the board and saves it with the reply added and
  `If-Match` set to the hash it read. A save that lands in between answers
  412, and the dispatcher reads and tries again, up to 3 times.
- **Replay.** On every stream connect it scans that surface for pending and
  in-flight deliveries, because no stream replays.
- **Failure.** A failed dispatch is retried after 5 seconds, doubling per
  failure up to 5 minutes, on one timer per annotation. A new event for an
  annotation in backoff waits for that timer. A retry after T3 accepted the
  turn redoes only the studio writes. A dropped stream reconnects after 2
  seconds, doubling to 1 minute while the server stays down, and re-reads the
  state file.

## Tests

```sh
bun test            # in packages/dispatcher
bun run typecheck
```

The tests run the real loop against in-process doubles of docs-server
(`test/fake-docs-server.ts`), Canvas Studio (`test/fake-canvas-studio.ts`) and
the Prompt service (`test/fake-prompt-service.ts`), and a fake `t3` on PATH
(`test/bin/t3`) that records calls and prints ids.
