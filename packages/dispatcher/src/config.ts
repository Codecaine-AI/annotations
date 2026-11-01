import { homedir } from "node:os";
import { join } from "node:path";

export const SURFACES = ["docs", "canvas", "prompt"] as const;
export type Surface = (typeof SURFACES)[number];

/**
 * Dispatcher settings. Every key can come from the JSON file named by
 * `DISPATCHER_CONFIG` (default `~/.config/codecaine-dispatcher/config.json`)
 * or from the matching `DISPATCHER_*` environment variable, which wins.
 */
export type DispatcherConfig = {
  /** The surfaces to serve. A comma list in the env var, a list or comma string in the file. */
  surfaces: Surface[];
  /** Base URL of one docs project API, without `/api`. Used as-is, with no token. */
  docsUrl?: string;
  /** Docs daemon state file holding `{ url, token }`. Read on every connect, because the token changes when the daemon restarts. */
  docsStateFile: string;
  /** Docs project id, appended to the daemon url as `/projects/<id>`. Required for docs when `docsUrl` is unset. */
  docsProject?: string;
  /** T3 project for docs pages: a path inside the repo that owns the pages, or a project id. Required for docs. */
  t3Project?: string;
  /** Canvas Studio base URL, whose file API serves the boards and their annotation events. */
  canvasStudioUrl: string;
  /** T3 project for standalone boards: the canvas repo. */
  canvasT3Project: string;
  /** Prompt service state file holding `{ url, token }`. Read on every connect. */
  promptStateFile: string;
  /** The workspace whose prompt catalog is served: the Prompt Studio's workspace. */
  promptWorkspace: string;
  /** T3 project for prompts: the prompt-kit repo. */
  promptT3Project: string;
  /** T3 CLI executable. Resolved on PATH when it has no slash. */
  t3Bin: string;
  /** Provider instance id and model slug for new threads. Required when the T3 project has no default model. Set both or neither. */
  t3Provider?: string;
  t3Model?: string;
  /** Log file. Lines go to stdout when unset. */
  logPath?: string;
};

export const ENV_KEYS = {
  surfaces: "DISPATCHER_SURFACES",
  docsUrl: "DISPATCHER_DOCS_URL",
  docsStateFile: "DISPATCHER_DOCS_STATE_FILE",
  docsProject: "DISPATCHER_DOCS_PROJECT",
  t3Project: "DISPATCHER_T3_PROJECT",
  canvasStudioUrl: "DISPATCHER_CANVAS_STUDIO_URL",
  canvasT3Project: "DISPATCHER_CANVAS_T3_PROJECT",
  promptStateFile: "DISPATCHER_PROMPT_STATE_FILE",
  promptWorkspace: "DISPATCHER_PROMPT_WORKSPACE",
  promptT3Project: "DISPATCHER_PROMPT_T3_PROJECT",
  t3Bin: "DISPATCHER_T3_BIN",
  t3Provider: "DISPATCHER_T3_PROVIDER",
  t3Model: "DISPATCHER_T3_MODEL",
  logPath: "DISPATCHER_LOG_PATH",
} as const;

const CORE = join(homedir(), "workspace", "codebases", "codecaine", "core");

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "codecaine-dispatcher", "config.json");
export const DEFAULT_DOCS_STATE_FILE = join(homedir(), ".local", "state", "codecaine-docs", "daemon.json");
/** Canvas Studio's dev server port (canvas repo, packages/studio/vite.config.ts). */
export const DEFAULT_CANVAS_STUDIO_URL = "http://127.0.0.1:3999";
export const DEFAULT_CANVAS_T3_PROJECT = join(CORE, "canvas");
/** The Prompt service's state file (prompt-kit-mcp/src/lifecycle.ts, `stateDirectory()`). */
export const DEFAULT_PROMPT_STATE_FILE = join(homedir(), ".local", "state", "codecaine-prompts", "daemon.json");
export const DEFAULT_PROMPT_KIT = join(CORE, "prompt-kit");

export async function loadConfig(env: Record<string, string | undefined> = process.env): Promise<DispatcherConfig> {
  const file = env.DISPATCHER_CONFIG ?? DEFAULT_CONFIG_PATH;
  const text = await Bun.file(file).text().catch(() => null);
  const fromFile = (text === null ? {} : JSON.parse(text)) as Record<string, unknown>;
  const pick = (key: keyof typeof ENV_KEYS): string | undefined => {
    const value = env[ENV_KEYS[key]] ?? fromFile[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const surfaces = parseSurfaces(env[ENV_KEYS.surfaces] ?? fromFile.surfaces, file);
  const t3Project = pick("t3Project");
  const docsUrl = pick("docsUrl");
  const docsProject = pick("docsProject");
  if (surfaces.includes("docs")) {
    if (!t3Project) throw new Error(`t3Project is required for docs: set ${ENV_KEYS.t3Project} or "t3Project" in ${file}`);
    if (!docsUrl && !docsProject) {
      throw new Error(`docsProject is required for docs when docsUrl is unset: set ${ENV_KEYS.docsProject} or "docsProject" in ${file}`);
    }
  }
  const t3Provider = pick("t3Provider");
  const t3Model = pick("t3Model");
  if ((t3Provider === undefined) !== (t3Model === undefined)) {
    throw new Error(`t3Provider and t3Model go together: set both ${ENV_KEYS.t3Provider} and ${ENV_KEYS.t3Model}, or neither`);
  }
  const promptWorkspace = pick("promptWorkspace") ?? DEFAULT_PROMPT_KIT;
  return {
    surfaces,
    docsUrl,
    docsStateFile: pick("docsStateFile") ?? DEFAULT_DOCS_STATE_FILE,
    docsProject,
    t3Project,
    canvasStudioUrl: pick("canvasStudioUrl") ?? DEFAULT_CANVAS_STUDIO_URL,
    canvasT3Project: pick("canvasT3Project") ?? DEFAULT_CANVAS_T3_PROJECT,
    promptStateFile: pick("promptStateFile") ?? DEFAULT_PROMPT_STATE_FILE,
    promptWorkspace,
    promptT3Project: pick("promptT3Project") ?? DEFAULT_PROMPT_KIT,
    t3Bin: pick("t3Bin") ?? "t3",
    t3Provider,
    t3Model,
    logPath: pick("logPath"),
  };
}

function parseSurfaces(raw: unknown, file: string): Surface[] {
  if (raw === undefined) return [...SURFACES];
  const names = (Array.isArray(raw) ? raw : String(raw).split(",")).map((name) => String(name).trim()).filter(Boolean);
  const unknown = names.filter((name) => !(SURFACES as readonly string[]).includes(name));
  if (unknown.length > 0 || names.length === 0) {
    throw new Error(`surfaces must list one or more of ${SURFACES.join(", ")} (${ENV_KEYS.surfaces} or "surfaces" in ${file}); got ${JSON.stringify(raw)}`);
  }
  return [...new Set(names)] as Surface[];
}
