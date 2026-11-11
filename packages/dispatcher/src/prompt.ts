/**
 * The Prompt Kit surface: the Prompt service (prompt-kit-mcp daemon) and its
 * annotation routes (prompt-kit-server/src/annotation-routes.ts). Every call
 * carries the service's bearer token, read from its state file on every
 * stream connect. The token goes only into request headers, never into a
 * route, an error or the log.
 */
import { isAbsolute, join, relative, sep } from "node:path";

import {
  DISPATCHER_ACTOR,
  messageTail,
  requestJson,
  sseJson,
  SYSTEM_AUTHOR,
  type Annotation,
  type AnnotationChange,
  type AnnotationThread,
  type RequestFacts,
  type Source,
  type SourceEvent,
} from "./source";

type PromptAnnotationEvent = { root: string; path: string; annotationId: string; change: AnnotationChange; intent: string; actor: string };
type Service = { url: string; token: string };
/** One prompt in the catalog: the project root and the root-relative prompt path the annotation routes key on. */
type CatalogEntry = { root: string; path: string; title: string };
type Discovery = { projects?: { root: string; prompts: { title: string; target: { promptPath: string } }[] }[] };

/** Targets are absolute prompt file paths. */
export class PromptSource implements Source {
  readonly surface = "prompt";
  private service: Service | null = null;
  private catalog = new Map<string, CatalogEntry>();

  constructor(
    private readonly stateFile: string,
    /** The workspace whose prompt catalog the dispatcher serves: the Prompt Studio's workspace. */
    private readonly workspace: string,
    readonly t3Project: string,
  ) {}

  private async connect(): Promise<Service> {
    const state = (await Bun.file(this.stateFile).json().catch(() => null)) as Partial<Service> | null;
    if (!state?.url || !state.token) throw new Error(`Prompt service state has no url or token: ${this.stateFile}`);
    this.service = { url: state.url.replace(/\/+$/, ""), token: state.token };
    return this.service;
  }

  private async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const service = this.service ?? (await this.connect());
    const { data } = await requestJson<T>(`${service.url}${route}`, route, {
      method,
      headers: { authorization: `Bearer ${service.token}` },
      body,
    });
    return data;
  }

  /** Re-reads the catalog through the service's `prompts_discover` tool. */
  private async discover(): Promise<void> {
    const result = await this.request<{ structuredContent?: Discovery & { ok?: boolean; detail?: string } }>("POST", "/rpc", {
      workspace: this.workspace,
      name: "prompts_discover",
      arguments: {},
    });
    const found = result.structuredContent;
    if (!found || found.ok === false) throw new Error(`prompts_discover failed: ${found?.detail ?? "no result"}`);
    const catalog = new Map<string, CatalogEntry>();
    for (const project of found.projects ?? []) {
      for (const prompt of project.prompts) {
        const path = prompt.target.promptPath;
        catalog.set(join(project.root, path), { root: project.root, path, title: prompt.title || path });
      }
    }
    this.catalog = catalog;
  }

  private async entry(target: string): Promise<CatalogEntry> {
    const found = this.catalog.get(target);
    if (found) return found;
    await this.discover();
    const fresh = this.catalog.get(target);
    if (!fresh) throw new Error(`prompt is not in the catalog of ${this.workspace}: ${target}`);
    return fresh;
  }

  private async route(target: string, action = ""): Promise<string> {
    const { root, path } = await this.entry(target);
    return `/api/annotations${action}?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;
  }

  async targets(): Promise<string[]> {
    await this.discover();
    return [...this.catalog.keys()];
  }

  async annotations(target: string): Promise<Annotation[]> {
    return (await this.request<{ annotations: Annotation[] }>("GET", await this.route(target))).annotations;
  }

  async title(target: string): Promise<string> {
    return (await this.entry(target)).title;
  }

  async setThread(target: string, annotationId: string, thread: AnnotationThread): Promise<void> {
    await this.request("PUT", await this.route(target, `/${encodeURIComponent(annotationId)}/thread`), { thread, actor: DISPATCHER_ACTOR });
  }

  async reply(target: string, annotationId: string, body: string): Promise<void> {
    await this.request("POST", await this.route(target, `/${encodeURIComponent(annotationId)}/replies`), { body, author: SYSTEM_AUTHOR });
  }

  async *events(signal: AbortSignal): AsyncGenerator<SourceEvent> {
    const { url, token } = await this.connect();
    for await (const payload of sseJson(`${url}/api/events`, "/api/events", { authorization: `Bearer ${token}` }, signal)) {
      if (payload === null) {
        yield { kind: "open" };
        continue;
      }
      const event = payload as PromptAnnotationEvent;
      const target = join(event.root, event.path);
      // The service serves every root. Only prompts in this workspace's catalog belong to this T3 project,
      // so a path outside the workspace is dropped before any request.
      if (!this.catalog.has(target)) {
        if (!this.inWorkspace(target)) continue;
        await this.discover().catch(() => {});
        if (!this.catalog.has(target)) continue;
      }
      yield { kind: "annotation", target, annotationId: event.annotationId, intent: event.intent, change: event.change, actor: event.actor };
    }
  }

  private inWorkspace(target: string): boolean {
    const path = relative(this.workspace, target);
    return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  }

  message(facts: RequestFacts): string {
    const entry = this.catalog.get(facts.target);
    const lead =
      facts.kind === "created"
        ? `A human filed a request on the prompt "${facts.title}" (${facts.target}).`
        : `A human replied on the prompt "${facts.title}" (${facts.target}).`;
    return [
      "Load the prompt-kit skill before you start.",
      "",
      lead,
      `Find the prompt with prompts_discover, passing project to list one project's prompts. Call prompts_begin, and read the request with prompts_requests. Do the work, then answer through the prompt-kit MCP request tool: reply with prompts_request_reply using request_id "${facts.annotationId}", and close the request with prompts_request_reply and close: true when it is done.`,
      ...messageTail(facts, [`Prompt: ${entry?.path ?? facts.target}`, ...(entry ? [`Project root: ${entry.root}`] : [])]),
    ].join("\n");
  }
}
