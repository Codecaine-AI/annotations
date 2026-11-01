/**
 * The action log: one SQLite file per machine that every Codecaine MCP
 * server appends to. A record is one tool call: who acted, with which tool,
 * on which target, with what result. Payloads never go in: `result` is a
 * short summary, and anything longer is cut.
 *
 * Identity. A record always carries the `runId` its server process minted at
 * start (`newRunId`). It carries a `threadId` when the process knows one:
 * Claude Code under T3 Code exports `T3CODE_THREAD_ID` to every MCP server it
 * starts, and `identityFromEnv` reads it. A process that learns its thread
 * later, from the surface's begin tool, calls `bindThread(runId, threadId)`
 * once, and every record of that run joins the thread through `run_threads`.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { migrate } from "./schema";

export type ActionRecord = {
  /** The server process that served the call. */
  runId: string;
  /** The T3 thread, when the process knows it at write time. */
  threadId?: string | null;
  /** Who acted: the harness string from `AI_AGENT` when set, else the server's own name. */
  agent: string;
  /** The MCP tool name, such as `docs_write_text`. */
  tool: string;
  /** The board id, page path or prompt path the call acted on. */
  target: string;
  /** A short outcome summary, such as `ok`, `refused: stale revision` or `2 findings`. Never a payload. */
  result: string;
  /** The guidance snapshot id the server served, when the call had one. */
  snapshotId?: string | null;
  at: string | Date;
};

export type StoredRecord = {
  id: number;
  runId: string;
  /** The record's own thread id, else the thread its run was bound to, else null. */
  threadId: string | null;
  agent: string;
  tool: string;
  target: string;
  result: string;
  snapshotId: string | null;
  at: string;
};

export type Query = {
  threadId?: string;
  target?: string;
  runId?: string;
  /** Inclusive lower bound. */
  since?: string | Date;
  /** Exclusive upper bound. */
  until?: string | Date;
  /** Rows returned at most. Defaults to `QUERY_LIMIT`; must be a positive whole number. */
  limit?: number;
};

export type Identity = { threadId: string | null; agent: string | null };

/** `result` is cut to this many characters so a payload cannot land in the log by mistake. */
export const RESULT_LIMIT = 500;

/** Rows a query returns when the caller sets no limit, so one read of a large log never blocks a daemon. */
export const QUERY_LIMIT = 1000;

const BUSY_TIMEOUT_MS = 5000;

type Row = { id: number; run_id: string; thread_id: string | null; agent: string; tool: string; target: string; result: string; snapshot_id: string | null; at: string };

/** `CODECAINE_ACTION_LOG` when set, else `~/.codecaine/action-log.sqlite`. */
export function defaultPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODECAINE_ACTION_LOG || join(homedir(), ".codecaine", "action-log.sqlite");
}

/** A fresh run id. Each server process mints one at start and keeps it for its life. */
export function newRunId(): string {
  return crypto.randomUUID();
}

/**
 * What the harness tells the server process about who it serves. Claude Code
 * under T3 Code sets `T3CODE_THREAD_ID` and `AI_AGENT`; Codex sets neither.
 */
export function identityFromEnv(env: NodeJS.ProcessEnv = process.env): Identity {
  return { threadId: env.T3CODE_THREAD_ID || null, agent: env.AI_AGENT || null };
}

export class ActionLog {
  private constructor(
    readonly path: string,
    private readonly db: Database,
  ) {}

  /** Opens the log, creating the folder, the file and the schema when missing. */
  static open(options: { path?: string } = {}): ActionLog {
    const path = options.path ?? defaultPath();
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path, { create: true, strict: true });
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    enableWal(db);
    db.exec("PRAGMA synchronous = NORMAL");
    migrate(db);
    return new ActionLog(path, db);
  }

  /** Appends one record and returns its id. */
  record(record: ActionRecord): number {
    for (const field of ["runId", "agent", "tool", "target"] as const) {
      if (!record[field]) throw new Error(`action log record needs a ${field}`);
    }
    const result = record.result.length > RESULT_LIMIT ? `${record.result.slice(0, RESULT_LIMIT - 1)}…` : record.result;
    const inserted = this.db.run(
      "INSERT INTO records (run_id, thread_id, agent, tool, target, result, snapshot_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [record.runId, record.threadId ?? null, record.agent, record.tool, record.target, result, record.snapshotId ?? null, iso(record.at)],
    );
    return Number(inserted.lastInsertRowid);
  }

  /**
   * Binds a run to its thread, so every record of the run, earlier and later,
   * resolves to that thread. The first binding wins and later calls are no-ops,
   * so a begin tool can call this on every invocation. Returns the thread the
   * run is bound to after the call.
   */
  bindThread(runId: string, threadId: string): string {
    if (!runId || !threadId) throw new Error("bindThread needs a run id and a thread id");
    this.db.run("INSERT OR IGNORE INTO run_threads (run_id, thread_id, bound_at) VALUES (?, ?, ?)", [runId, threadId, new Date().toISOString()]);
    const bound = this.db.query<{ thread_id: string }, [string]>("SELECT thread_id FROM run_threads WHERE run_id = ?").get(runId);
    return bound!.thread_id;
  }

  /** Records matching every given filter, oldest first, at most `limit` rows (default `QUERY_LIMIT`). */
  query(filter: Query = {}): StoredRecord[] {
    const limit = filter.limit ?? QUERY_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`limit must be a positive whole number, got ${String(filter.limit)}`);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.threadId !== undefined) { where.push("thread_id = ?"); params.push(filter.threadId); }
    if (filter.target !== undefined) { where.push("target = ?"); params.push(filter.target); }
    if (filter.runId !== undefined) { where.push("run_id = ?"); params.push(filter.runId); }
    if (filter.since !== undefined) { where.push("at >= ?"); params.push(iso(filter.since)); }
    if (filter.until !== undefined) { where.push("at < ?"); params.push(iso(filter.until)); }
    params.push(limit);
    const sql = `SELECT * FROM actions${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY at, id LIMIT ?`;
    return this.db.query<Row, (string | number)[]>(sql).all(...params).map(fromRow);
  }

  close(): void {
    this.db.close();
  }
}

export function openActionLog(options: { path?: string } = {}): ActionLog {
  return ActionLog.open(options);
}

/**
 * Switches the file to WAL. SQLite opens a read transaction before it takes
 * the write lock for this switch, and in that state it returns SQLITE_BUSY
 * without calling the busy handler. Two processes opening a fresh file at
 * once hit it, so this retries for the same window the busy timeout gives.
 * A file already in WAL mode returns at once.
 */
function enableWal(db: Database): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      const busy = typeof error === "object" && error !== null && (error as { code?: unknown }).code === "SQLITE_BUSY";
      if (!busy || Date.now() >= deadline) throw error;
      Bun.sleepSync(5 + Math.random() * 20);
    }
  }
}

function iso(at: string | Date): string {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) throw new Error(`not a time: ${String(at)}`);
  return date.toISOString();
}

function fromRow(row: Row): StoredRecord {
  return { id: row.id, runId: row.run_id, threadId: row.thread_id, agent: row.agent, tool: row.tool, target: row.target, result: row.result, snapshotId: row.snapshot_id, at: row.at };
}
