import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Dispatcher settings. Every key can come from the JSON file named by
 * `DISPATCHER_CONFIG` (default `~/.config/codecaine-dispatcher/config.json`)
 * or from the matching `DISPATCHER_*` environment variable, which wins.
 */
export type DispatcherConfig = {
  /** Base URL of one docs project API, without `/api`. Used as-is, with no token. */
  docsUrl?: string;
  /** Docs daemon state file holding `{ url, token }`. Read on every connect, because the token changes when the daemon restarts. */
  docsStateFile: string;
  /** Docs project id, appended to the daemon url as `/projects/<id>`. Required when `docsUrl` is unset. */
  docsProject?: string;
  /** T3 project: a path inside the repo that owns the pages, or a project id. */
  t3Project: string;
  /** T3 CLI executable. Resolved on PATH when it has no slash. */
  t3Bin: string;
  /** Provider instance id and model slug for new threads. Required when the T3 project has no default model. Set both or neither. */
  t3Provider?: string;
  t3Model?: string;
  /** Log file. Lines go to stdout when unset. */
  logPath?: string;
};

export const ENV_KEYS = {
  docsUrl: "DISPATCHER_DOCS_URL",
  docsStateFile: "DISPATCHER_DOCS_STATE_FILE",
  docsProject: "DISPATCHER_DOCS_PROJECT",
  t3Project: "DISPATCHER_T3_PROJECT",
  t3Bin: "DISPATCHER_T3_BIN",
  t3Provider: "DISPATCHER_T3_PROVIDER",
  t3Model: "DISPATCHER_T3_MODEL",
  logPath: "DISPATCHER_LOG_PATH",
} as const;

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "codecaine-dispatcher", "config.json");
export const DEFAULT_DOCS_STATE_FILE = join(homedir(), ".local", "state", "codecaine-docs", "daemon.json");

export async function loadConfig(env: Record<string, string | undefined> = process.env): Promise<DispatcherConfig> {
  const file = env.DISPATCHER_CONFIG ?? DEFAULT_CONFIG_PATH;
  const text = await Bun.file(file).text().catch(() => null);
  const fromFile = (text === null ? {} : JSON.parse(text)) as Record<string, unknown>;
  const pick = (key: keyof typeof ENV_KEYS): string | undefined => {
    const value = env[ENV_KEYS[key]] ?? fromFile[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const t3Project = pick("t3Project");
  if (!t3Project) throw new Error(`t3Project is required: set ${ENV_KEYS.t3Project} or "t3Project" in ${file}`);
  const docsUrl = pick("docsUrl");
  const docsProject = pick("docsProject");
  if (!docsUrl && !docsProject) {
    throw new Error(`docsProject is required when docsUrl is unset: set ${ENV_KEYS.docsProject} or "docsProject" in ${file}`);
  }
  const t3Provider = pick("t3Provider");
  const t3Model = pick("t3Model");
  if ((t3Provider === undefined) !== (t3Model === undefined)) {
    throw new Error(`t3Provider and t3Model go together: set both ${ENV_KEYS.t3Provider} and ${ENV_KEYS.t3Model}, or neither`);
  }
  return {
    docsUrl,
    docsStateFile: pick("docsStateFile") ?? DEFAULT_DOCS_STATE_FILE,
    docsProject,
    t3Project,
    t3Bin: pick("t3Bin") ?? "t3",
    t3Provider,
    t3Model,
    logPath: pick("logPath"),
  };
}
