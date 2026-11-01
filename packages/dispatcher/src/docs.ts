/**
 * The docs surface: one docs project served by docs-server (`/api/*` routes),
 * including its SSE change stream. The route shapes mirror
 * docs-system/packages/docs-server/src/routes.ts.
 */
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

export type DocsChangeEvent = {
  path: string;
  changedIds: string[];
  patchId: string;
  actor: string;
  annotation?: { id: string; intent: string; change: AnnotationChange };
};

type TreeNode = { name: string; path: string; kind: "dir" | "file" | "bundle"; children?: TreeNode[] };

export type DocsEndpoint = { url: string; token?: string };

/** Resolves the project API base URL: an explicit url, or the daemon state file plus a project id. */
export async function resolveDocsEndpoint(config: {
  docsUrl?: string;
  docsStateFile: string;
  docsProject?: string;
}): Promise<DocsEndpoint> {
  if (config.docsUrl) return { url: config.docsUrl.replace(/\/+$/, "") };
  const state = (await Bun.file(config.docsStateFile).json().catch(() => null)) as { url?: string; token?: string } | null;
  if (!state?.url) throw new Error(`Docs daemon state has no url: ${config.docsStateFile}`);
  return { url: `${state.url.replace(/\/+$/, "")}/projects/${config.docsProject}`, token: state.token };
}

/** Targets are page paths. */
export class DocsSource implements Source {
  readonly surface = "docs";
  private endpoint: DocsEndpoint | null = null;

  constructor(
    private readonly resolve: () => Promise<DocsEndpoint>,
    readonly t3Project: string,
  ) {}

  private async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const endpoint = this.endpoint ?? (this.endpoint = await this.resolve());
    const { data } = await requestJson<T>(`${endpoint.url}${route}`, route, { method, headers: auth(endpoint), body });
    return data;
  }

  /** Every doc bundle path in the project, depth first. */
  async targets(): Promise<string[]> {
    const { tree } = await this.request<{ tree: TreeNode[] }>("GET", "/api/tree");
    const paths: string[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.kind === "bundle") paths.push(node.path);
        if (node.children) walk(node.children);
      }
    };
    walk(tree);
    return paths;
  }

  /** The page title from its doc, or the path when the doc has none. */
  async title(path: string): Promise<string> {
    const bundle = await this.request<{ doc?: { title?: unknown } }>("GET", `/api/bundle?path=${encodeURIComponent(path)}`);
    const title = bundle.doc?.title;
    return typeof title === "string" && title.trim().length > 0 ? title.trim() : path;
  }

  async annotations(path: string): Promise<Annotation[]> {
    const result = await this.request<{ annotations: { annotations: Annotation[] } }>(
      "GET",
      `/api/annotations?path=${encodeURIComponent(path)}`,
    );
    return result.annotations.annotations;
  }

  async setThread(path: string, annotationId: string, thread: AnnotationThread): Promise<void> {
    await this.request("PUT", `/api/annotations/${encodeURIComponent(annotationId)}/thread`, {
      path,
      thread,
      session_id: DISPATCHER_ACTOR,
    });
  }

  async reply(path: string, annotationId: string, body: string): Promise<void> {
    await this.request("POST", `/api/annotations/${encodeURIComponent(annotationId)}/replies`, {
      path,
      body,
      author: SYSTEM_AUTHOR,
      session_id: DISPATCHER_ACTOR,
    });
  }

  /** Re-reads the daemon state on every connect, because the token changes when the daemon restarts. */
  async *events(signal: AbortSignal): AsyncGenerator<SourceEvent> {
    const endpoint = (this.endpoint = await this.resolve());
    for await (const payload of sseJson(`${endpoint.url}/api/events`, "/api/events", auth(endpoint), signal)) {
      if (payload === null) {
        yield { kind: "open" };
        continue;
      }
      const event = payload as DocsChangeEvent;
      if (event.annotation) {
        const { id, intent, change } = event.annotation;
        yield { kind: "annotation", target: event.path, annotationId: id, intent, change, actor: event.actor };
      } else if (event.path && event.actor !== DISPATCHER_ACTOR) {
        // A plain change event, such as the file watcher's, says only which
        // page changed. Re-reading its annotations covers requests written
        // outside the API, for instance through the docs MCP in another process.
        yield { kind: "touched", target: event.path };
      }
    }
  }

  message(facts: RequestFacts): string {
    const lead =
      facts.kind === "created"
        ? `A human filed a request on the docs page "${facts.title}" (${facts.target}).`
        : `A human replied on the docs page "${facts.title}" (${facts.target}).`;
    return [
      "Load the docs-system skill before you start.",
      "",
      lead,
      `Read the page with the docs MCP tools, do the work, then answer through the docs MCP annotation tools: reply with docs_annotation_reply using author "agent" and annotation_id "${facts.annotationId}", and resolve the annotation with docs_annotation_resolve when the request is done.`,
      ...messageTail(facts, [`Page: ${facts.target}`]),
    ].join("\n");
  }
}

function auth(endpoint: DocsEndpoint): Record<string, string> {
  return endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {};
}
