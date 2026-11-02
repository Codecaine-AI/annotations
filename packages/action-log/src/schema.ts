/**
 * The schema, as versioned migrations. Each entry runs once, inside an
 * immediate transaction, and is recorded in `migrations`. Add a new version
 * for every change; never edit a shipped one.
 */
import type { Database } from "bun:sqlite";

export const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      -- One row per MCP tool call. run_id is the process that served the call;
      -- thread_id is set when the process knew its thread at write time.
      CREATE TABLE records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        thread_id TEXT,
        agent TEXT NOT NULL,
        tool TEXT NOT NULL,
        target TEXT NOT NULL,
        result TEXT NOT NULL,
        snapshot_id TEXT,
        at TEXT NOT NULL
      );
      CREATE INDEX records_thread ON records (thread_id, at);
      CREATE INDEX records_target ON records (target, at);
      CREATE INDEX records_run ON records (run_id, at);
      CREATE INDEX records_at ON records (at);

      -- A run learns its thread at most once, from the surface's begin tool.
      -- Rows are inserted, never updated.
      CREATE TABLE run_threads (
        run_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        bound_at TEXT NOT NULL
      );
      CREATE INDEX run_threads_thread ON run_threads (thread_id);

      -- Records with the thread resolved: the record's own thread id, else
      -- the thread its run was bound to. Query this view, not the tables.
      CREATE VIEW actions AS
        SELECT r.id, r.run_id, COALESCE(r.thread_id, b.thread_id) AS thread_id,
               r.agent, r.tool, r.target, r.result, r.snapshot_id, r.at
        FROM records r LEFT JOIN run_threads b ON b.run_id = r.run_id;
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** Applies every migration the file lacks. Safe to run from several processes at once. */
export function migrate(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const apply = db.transaction((migration: { version: number; sql: string }) => {
    // Claim the version first: under BEGIN IMMEDIATE a second process waits, then finds it claimed.
    const claimed = db.run("INSERT OR IGNORE INTO migrations (version, applied_at) VALUES (?, ?)", [migration.version, new Date().toISOString()]);
    if (claimed.changes === 1) db.exec(migration.sql);
  });
  for (const migration of MIGRATIONS) apply.immediate(migration);
}
