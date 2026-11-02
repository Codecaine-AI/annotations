/** Puts the fake `t3` (test/bin/t3) first on PATH with a fresh state dir, and reads back its calls. */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type T3Call = { args: string[]; stdin: string };

export function useFakeT3(): { state: string; callsOf: (subcommand: string) => T3Call[]; turnsFor: (annotationId: string) => T3Call[] } {
  const state = mkdtempSync(join(tmpdir(), "dispatcher-test-"));
  process.env.T3_FAKE_STATE = state;
  process.env.PATH = `${join(import.meta.dir, "bin")}:${process.env.PATH}`;
  const calls = (): T3Call[] => {
    const file = join(state, "calls.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as T3Call);
  };
  return {
    state,
    callsOf: (subcommand) => calls().filter((call) => call.args[1] === subcommand),
    /** The turns T3 received for one annotation: thread starts and sends whose message names it. */
    turnsFor: (annotationId) =>
      calls().filter((call) => (call.args[1] === "start" || call.args[1] === "send") && call.stdin.includes(`Annotation: ${annotationId}\n`)),
  };
}

/** The value after `flag` in a recorded call. */
export function flag(call: T3Call | undefined, name: string): string | undefined {
  if (!call) return undefined;
  const index = call.args.indexOf(name);
  return index === -1 ? undefined : call.args[index + 1];
}
