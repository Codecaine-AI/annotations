// Appends `count` records into one log file, one insert per record, as a
// server would. The concurrency test spawns two of these at once.
import { openActionLog } from "../src";

const [path, runId, count] = process.argv.slice(2);
if (!path || !runId || !count) throw new Error("usage: writer.ts PATH RUN_ID COUNT");
const log = openActionLog({ path });
for (let i = 0; i < Number(count); i++) {
  log.record({ runId, agent: "writer", tool: "docs_write_text", target: "docs/shared", result: `ok ${i}`, at: new Date() });
}
log.close();
