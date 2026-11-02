import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The repo root preloads happy-dom for the React tests. These tests spawn
// processes and read their streams, so they need Bun's own Response back.
if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();

import { formatLine, parseArgs } from "./cli";
import { openActionLog, type StoredRecord } from "./log";

const CLI = join(import.meta.dir, "cli.ts");
const THREAD_A = "f571f4c5-f879-4ca0-86e6-9e56c3555765";
const THREAD_B = "825d4fd6-bbee-499f-9a3e-d4211d5353da";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

test("query prints one line per record, filtered by thread, target or time, and JSON lines on request", async () => {
  dir = mkdtempSync(join(tmpdir(), "action-log-cli-"));
  const path = join(dir, "log.sqlite");
  const log = openActionLog({ path });
  log.record({ runId: "run-a", threadId: THREAD_A, agent: "claude-code", tool: "place_shape", target: "canvases/flow", result: "ok\n2 findings", snapshotId: "snap-1", at: "2026-11-01T10:00:00.000Z" });
  log.record({ runId: "run-b", threadId: THREAD_B, agent: "codex", tool: "docs_write_text", target: "docs/page", result: "ok", at: "2026-11-01T11:00:00.000Z" });
  log.close();

  const byThread = await run(["query", "--thread", THREAD_A, "--path", path]);
  expect(byThread.code).toBe(0);
  expect(byThread.stdout).toBe(`2026-11-01T10:00:00.000Z\t${THREAD_A}\trun-a\tclaude-code\tplace_shape\tcanvases/flow\tok 2 findings\tsnap-1\n`);

  const byTarget = await run(["query", "--target", "docs/page"], { CODECAINE_ACTION_LOG: path });
  expect(byTarget.stdout.split("\n").filter(Boolean)).toHaveLength(1);
  expect(byTarget.stdout).toContain("\tdocs_write_text\t");

  const since = await run(["query", "--since", "2026-11-01T10:30:00Z", "--json", "--path", path]);
  const records = since.stdout.trim().split("\n").map((line) => JSON.parse(line) as StoredRecord);
  expect(records.map((r) => [r.tool, r.threadId, r.snapshotId])).toEqual([["docs_write_text", THREAD_B, null]]);

  const all = await run(["query", "--path", path]);
  expect(all.stdout.split("\n").filter(Boolean)).toHaveLength(2);
});

test("query reports a missing file and a bad flag without creating a log", async () => {
  dir = mkdtempSync(join(tmpdir(), "action-log-cli-"));
  const path = join(dir, "missing.sqlite");
  const missing = await run(["query", "--path", path]);
  expect([missing.code, missing.stderr.trim()]).toEqual([1, `no action log at ${path}`]);
  const bad = await run(["query", "--bogus", "1", "--path", path]);
  expect(bad.code).toBe(2);
  expect(bad.stderr).toContain("unknown flag: --bogus");
  expect(() => parseArgs(["--limit", "0"])).toThrow("--limit");
});

test("formatLine marks empty fields and flattens whitespace", () => {
  const record: StoredRecord = { id: 1, runId: "run-z", threadId: null, agent: "codex", tool: "docs_begin", target: "docs/x", result: "line one\n\tline two", snapshotId: null, at: "2026-11-01T10:00:00.000Z" };
  expect(formatLine(record)).toBe("2026-11-01T10:00:00.000Z\t-\trun-z\tcodex\tdocs_begin\tdocs/x\tline one line two\t-");
});
