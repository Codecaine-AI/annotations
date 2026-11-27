# Agent notes

## Test commands
Run every command from the repo root. Annotations and `packages/*` are Codecaine core workspace members, so install with `bun install` at the core root. Packages resolve dependencies from core's `node_modules`.

**Tier 1, every change:** `bun run typecheck` (and `bun run --cwd packages/<name> typecheck` for a package change), then the focused command for each changed test or its owner: `bun test ./<file>` from the repo root, or `bun test <file>` from the package folder.

**Tier 2, before a PR:** there is no changed-files gate and no CI. Diff base: `origin/main`. Run the full suite of every area the diff touches:

| Area | Owns | Command | Size, wall time |
|---|---|---|---|
| `src` | `@codecaine-ai/annotations`: core schema (`/core`), React panel, composer, targeting layer (`/react`) | `bun test ./src` | 4 files, 68 tests, under 1 s |
| `packages/action-log` | `@codecaine-ai/action-log`: action log writer, schema, query CLI | `bun run --cwd packages/action-log test` | 2 files, 11 tests, under 1 s |
| `packages/dispatcher` | Annotation dispatcher: surfaces, canvas, docs and prompt sources, T3 launch | `bun run --cwd packages/dispatcher test` | 4 files, 29 tests, about 4 s |

Use `bun test ./src`, never `bun test src` (the root `test` script). A bare filter is a substring match, so `src` also runs `packages/*/src` and runs 6 files twice.

Routing rules:
- A change in `src/` runs `src`. Other core packages import `@codecaine-ai/annotations` (`/core`, `/react`): `docs-system` (docs-model, docs-viewer, docs-workbench) and `prompt-kit`. A change to an export also runs their suites.
- A change in `packages/action-log` runs action-log and dispatcher. `canvas-mcp`, `prompt-kit-mcp`, `docs-system/external/canvas` and Observatory import `@codecaine-ai/action-log`, so an export change runs theirs too.
- A change in `packages/dispatcher` runs dispatcher.
- A change only in `*.md` or `packages/dispatcher/launchd` runs no tests.

**Tier 3, before a big merge:** `bun run typecheck`, each package's `typecheck`, then the three Tier 2 commands.

**Keeper tests:** these are the only proof of a user flow. A prune must keep them, test by test.

| Flow | Keeper |
|---|---|
| Click a target and get its resolved target | `src/__tests__/targeting.test.tsx` "fires onTargetSelect with the resolved target on click" |
| Write a note and save it with its intent | `src/__tests__/react-panel.test.tsx` "submits the composer with the toggled intent, then clears the selection" |
| Reply to an annotation | `src/__tests__/react-panel.test.tsx` "submits a trimmed reply body to onAddReply and clears the inline composer" |
| A harness writes the action log and the CLI queries it | `packages/action-log/src/cli.test.ts` "query prints one line per record, filtered by thread, target or time, and JSON lines on request" |
| A docs, board or prompt request starts a thread and gets the system reply | `packages/dispatcher/src/docs.test.ts` "a request on a page with no thread starts one, binds it, and tells the Lab", `canvas.test.ts` "a board request starts a thread in the canvas project, binds it, and posts the system reply on the board", `prompt.test.ts` "a prompt request starts a thread in the prompt-kit project, binds it, and posts the system reply" |

**Known failures on main:** none.

**Quarantine:** none. Each entry needs the test title, an owner and an expiry date.
