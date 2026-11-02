/**
 * `bun packages/action-log/src/cli.ts query [--thread ID] [--target PATH] [--run ID] [--since ISO] [--until ISO] [--limit N] [--json] [--path FILE]`
 *
 * Prints one line per record, oldest first. Filters combine with AND.
 * `--json` prints one JSON object per line for ingest.
 */
import { existsSync } from "node:fs";

import { defaultPath, openActionLog, type Query, type StoredRecord } from "./log";

const USAGE = `Usage: action-log query [--thread ID] [--target PATH] [--run ID] [--since ISO] [--until ISO] [--limit N] [--json] [--path FILE]
  Default file: ${defaultPath()} (CODECAINE_ACTION_LOG overrides)`;

export function parseArgs(argv: string[]): { filter: Query; json: boolean; path: string } {
  const flags = new Map<string, string>();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") { json = true; continue; }
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    flags.set(arg.slice(2), value);
  }
  const filter: Query = {};
  if (flags.has("thread")) filter.threadId = flags.get("thread");
  if (flags.has("target")) filter.target = flags.get("target");
  if (flags.has("run")) filter.runId = flags.get("run");
  if (flags.has("since")) filter.since = flags.get("since");
  if (flags.has("until")) filter.until = flags.get("until");
  if (flags.has("limit")) {
    const limit = Number(flags.get("limit"));
    if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit needs a positive whole number");
    filter.limit = limit;
  }
  for (const name of flags.keys()) {
    if (!["thread", "target", "run", "since", "until", "limit", "path"].includes(name)) throw new Error(`unknown flag: --${name}`);
  }
  return { filter, json, path: flags.get("path") ?? defaultPath() };
}

/** One line per record: time, thread, run, agent, tool, target, result, snapshot. `-` marks an empty field. */
export function formatLine(record: StoredRecord): string {
  const cell = (value: string | null) => (value === null || value === "" ? "-" : value.replace(/\s+/g, " "));
  return [record.at, cell(record.threadId), record.runId, cell(record.agent), record.tool, record.target, cell(record.result), cell(record.snapshotId)].join("\t");
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "query") {
    console.error(USAGE);
    process.exit(command === "--help" || command === "help" ? 0 : 2);
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(rest);
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    process.exit(2);
  }
  if (!existsSync(parsed.path)) {
    console.error(`no action log at ${parsed.path}`);
    process.exit(1);
  }
  const log = openActionLog({ path: parsed.path });
  try {
    for (const record of log.query(parsed.filter)) console.log(parsed.json ? JSON.stringify(record) : formatLine(record));
  } finally {
    log.close();
  }
}
