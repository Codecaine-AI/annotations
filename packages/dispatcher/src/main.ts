import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { loadConfig } from "./config";
import { Dispatcher } from "./dispatcher";
import { DocsClient, resolveDocsEndpoint } from "./docs";
import { T3 } from "./t3";

const config = await loadConfig();
const log = createLogger(config.logPath);
const dispatcher = new Dispatcher({
  docs: new DocsClient(() => resolveDocsEndpoint(config)),
  t3: new T3(config.t3Bin, config.t3Provider && config.t3Model ? { provider: config.t3Provider, model: config.t3Model } : undefined),
  t3Project: config.t3Project,
  log,
});

const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log(`${signal}: stopping`);
    controller.abort();
  });
}

log(`dispatcher start: docs ${config.docsUrl ?? `${config.docsStateFile} project ${config.docsProject}`}, t3 project ${config.t3Project}`);
await dispatcher.run(controller.signal);
log("dispatcher stopped");

function createLogger(path: string | undefined): (line: string) => void {
  if (path) mkdirSync(dirname(path), { recursive: true });
  return (line) => {
    const entry = `${new Date().toISOString()} ${line}\n`;
    if (path) appendFileSync(path, entry);
    else process.stdout.write(entry);
  };
}
