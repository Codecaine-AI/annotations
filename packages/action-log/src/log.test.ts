import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The repo root preloads happy-dom for the React tests. These tests spawn
// processes and read their streams, so they need Bun's own Response back.
if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();

import { identityFromEnv, openActionLog, type ActionLog, QUERY_LIMIT, RESULT_LIMIT } from "./log";
import { SCHEMA_VERSION } from "./schema";

const THREAD_A = "f571f4c5-f879-4ca0-86e6-9e56c3555765";
const THREAD_B = "825d4fd6-bbee-499f-9a3e-d4211d5353da";
const BOARD = "canvases/payments-flow";
const T0 = "2026-11-01T10:00:00.000Z";
const T1 = "2026-11-01T10:05:00.000Z";
const T2 = "2026-11-01T10:10:00.000Z";

const tempDirs: string[] = [];
const open: ActionLog[] = [];

function tempPath(name = "action-log.sqlite"): string {
  const dir = mkdtempSync(join(tmpdir(), "action-log-"));
  tempDirs.push(dir);
  return join(dir, name);
}

function openTemp(path = tempPath()): ActionLog {
  const log = openActionLog({ path });
  open.push(log);
  return log;
}

afterEach(() => {
  for (const log of open.splice(0)) log.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("two threads edit one board: each thread's query returns only its own edits, the board's query returns both", () => {
  const log = openTemp();
  log.record({ runId: "run-a", threadId: THREAD_A, agent: "claude-code", tool: "place_shape", target: BOARD, result: "ok", snapshotId: "snap-1", at: T0 });
  log.record({ runId: "run-b", threadId: THREAD_B, agent: "codex", tool: "move_to", target: BOARD, result: "ok, 1 finding", at: T1 });
  log.record({ runId: "run-a", threadId: THREAD_A, agent: "claude-code", tool: "connect", target: BOARD, result: "refused: stale board", at: T2 });

  expect(log.query({ threadId: THREAD_A }).map((r) => r.tool)).toEqual(["place_shape", "connect"]);
  expect(log.query({ threadId: THREAD_B }).map((r) => [r.tool, r.agent, r.snapshotId])).toEqual([["move_to", "codex", null]]);
  expect(log.query({ target: BOARD }).map((r) => r.threadId)).toEqual([THREAD_A, THREAD_B, THREAD_A]);
  expect(log.query({ target: "canvases/other" })).toEqual([]);
});

test("a record with only a run id joins its thread once the begin tool binds the run", () => {
  const log = openTemp();
  log.record({ runId: "run-x", agent: "codex", tool: "docs_discover", target: "docs", result: "3 projects", at: T0 });
  expect(log.query({ threadId: THREAD_A })).toEqual([]);
  expect(log.query({ runId: "run-x" })[0]?.threadId).toBeNull();

  expect(log.bindThread("run-x", THREAD_A)).toBe(THREAD_A);
  log.record({ runId: "run-x", agent: "codex", tool: "docs_begin", target: "docs/page", result: "task t1", snapshotId: "snap-2", at: T1 });

  const byThread = log.query({ threadId: THREAD_A });
  expect(byThread.map((r) => [r.tool, r.threadId])).toEqual([["docs_discover", THREAD_A], ["docs_begin", THREAD_A]]);
  // Binding again is a no-op, and the first binding wins over a later, different one.
  expect(log.bindThread("run-x", THREAD_A)).toBe(THREAD_A);
  expect(log.bindThread("run-x", THREAD_B)).toBe(THREAD_A);
  expect(log.query({ threadId: THREAD_B })).toEqual([]);
});

test("a record's own thread id wins over its run's binding", () => {
  const log = openTemp();
  log.bindThread("run-y", THREAD_A);
  log.record({ runId: "run-y", threadId: THREAD_B, agent: "claude-code", tool: "prompts_begin", target: "prompts/one", result: "ok", at: T0 });
  expect(log.query({ threadId: THREAD_B }).map((r) => r.tool)).toEqual(["prompts_begin"]);
  expect(log.query({ threadId: THREAD_A })).toEqual([]);
});

test("a time range is since-inclusive and until-exclusive, and combines with the other filters", () => {
  const log = openTemp();
  for (const [at, tool] of [[T0, "a"], [T1, "b"], [T2, "c"]] as const) {
    log.record({ runId: "run-t", threadId: THREAD_A, agent: "claude-code", tool, target: BOARD, result: "ok", at });
  }
  expect(log.query({ since: T1 }).map((r) => r.tool)).toEqual(["b", "c"]);
  expect(log.query({ until: T1 }).map((r) => r.tool)).toEqual(["a"]);
  expect(log.query({ since: new Date(T0), until: T2, threadId: THREAD_A, runId: "run-t", limit: 1 }).map((r) => r.tool)).toEqual(["a"]);
  expect(() => log.query({ since: "yesterday" })).toThrow("not a time");
});

test("two processes appending at once lose nothing", async () => {
  const path = tempPath();
  const writer = join(import.meta.dir, "..", "test", "writer.ts");
  const spawn = (runId: string) => Bun.spawn(["bun", writer, path, runId, "500"], { stdout: "ignore", stderr: "pipe" });
  const [one, two] = [spawn("run-1"), spawn("run-2")];
  const [codeOne, codeTwo, errOne, errTwo] = await Promise.all([one.exited, two.exited, new Response(one.stderr).text(), new Response(two.stderr).text()]);
  expect([codeOne, errOne, codeTwo, errTwo]).toEqual([0, "", 0, ""]);

  const log = openTemp(path);
  expect(log.query({ runId: "run-1" })).toHaveLength(500);
  expect(log.query({ runId: "run-2" })).toHaveLength(500);
  expect(log.query({ target: "docs/shared" })).toHaveLength(1000);
  log.record({ runId: "run-3", agent: "claude-code", tool: "docs_read", target: "docs/shared", result: "ok", at: T0 });
  expect(log.query({ target: "docs/shared" })).toHaveLength(QUERY_LIMIT);
  expect(log.query({ target: "docs/shared", limit: 1001 })).toHaveLength(1001);
  expect(() => log.query({ limit: 0 })).toThrow("positive whole number");
}, 30_000);

test("opening creates the folder and the versioned schema, and reopening keeps the records", () => {
  const path = join(tempPath(), "nested", "deeper", "action-log.sqlite");
  const first = openTemp(path);
  first.record({ runId: "run-r", agent: "claude-code", tool: "canvas_open", target: BOARD, result: "ok", at: T0 });
  first.close();
  open.pop();
  expect(existsSync(path)).toBe(true);

  const again = openTemp(path);
  expect(again.query().map((r) => r.tool)).toEqual(["canvas_open"]);
  expect(SCHEMA_VERSION).toBe(1);
});

test("a result longer than the limit is cut, and a record without its identity fields is refused", () => {
  const log = openTemp();
  log.record({ runId: "run-l", agent: "claude-code", tool: "docs_read", target: "docs/page", result: "x".repeat(RESULT_LIMIT + 50), at: T0 });
  expect(log.query()[0]?.result).toHaveLength(RESULT_LIMIT);
  expect(() => log.record({ runId: "", agent: "claude-code", tool: "docs_read", target: "docs/page", result: "ok", at: T0 })).toThrow("needs a runId");
  expect(() => log.record({ runId: "run-l", agent: "claude-code", tool: "docs_read", target: "docs/page", result: "ok", at: "soon" })).toThrow("not a time");
});

test("identityFromEnv reads the thread id Claude Code under T3 Code exports, and finds none under Codex", () => {
  expect(identityFromEnv({ T3CODE_THREAD_ID: THREAD_A, AI_AGENT: "claude-code_2-1-316_harness" })).toEqual({ threadId: THREAD_A, agent: "claude-code_2-1-316_harness" });
  expect(identityFromEnv({ HOME: "/Users/Ford", PATH: "/usr/bin" })).toEqual({ threadId: null, agent: null });
});
