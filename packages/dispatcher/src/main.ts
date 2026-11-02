import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { CanvasSource } from "./canvas";
import { loadConfig, type DispatcherConfig, type Surface } from "./config";
import { Dispatcher } from "./dispatcher";
import { DocsSource, resolveDocsEndpoint } from "./docs";
import { PromptSource } from "./prompt";
import type { Source } from "./source";
import { T3 } from "./t3";

const config = await loadConfig();
const log = createLogger(config.logPath);
const sources = config.surfaces.map((surface) => createSource(surface, config));
const dispatcher = new Dispatcher({
  sources,
  t3: new T3(config.t3Bin, config.t3Provider && config.t3Model ? { provider: config.t3Provider, model: config.t3Model } : undefined),
  log,
});

const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log(`${signal}: stopping`);
    controller.abort();
  });
}

log(`dispatcher start: ${sources.map((source) => `${source.surface} -> t3 project ${source.t3Project}`).join(", ")}`);
await dispatcher.run(controller.signal);
log("dispatcher stopped");

function createSource(surface: Surface, config: DispatcherConfig): Source {
  switch (surface) {
    case "docs":
      // loadConfig requires t3Project when docs is on.
      return new DocsSource(() => resolveDocsEndpoint(config), config.t3Project!);
    case "canvas":
      return new CanvasSource(config.canvasStudioUrl, config.canvasT3Project);
    case "prompt":
      return new PromptSource(config.promptStateFile, config.promptWorkspace, config.promptT3Project);
  }
}

function createLogger(path: string | undefined): (line: string) => void {
  if (path) mkdirSync(dirname(path), { recursive: true });
  return (line) => {
    const entry = `${new Date().toISOString()} ${line}\n`;
    if (path) appendFileSync(path, entry);
    else process.stdout.write(entry);
  };
}
