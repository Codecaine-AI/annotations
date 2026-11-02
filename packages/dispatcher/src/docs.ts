/**
 * HTTP client for one docs project served by docs-server (`/api/*` routes),
 * including its SSE change stream. The route shapes mirror
 * docs-system/packages/docs-server/src/routes.ts.
 */

export type AnnotationIntent = "note" | "agent-request";
export type AnnotationReply = { id: string; author: string; body: string; createdAt: string };
export type AnnotationThread = { id: string; title?: string };
export type Annotation = {
  id: string;
  body: string;
  intent: AnnotationIntent;
  author: string;
  status: "open" | "resolved";
  createdAt: string;
  replies?: AnnotationReply[];
  thread?: AnnotationThread;
};

export type DocsChangeEvent = {
  path: string;
  changedIds: string[];
  patchId: string;
  actor: string;
  annotation?: { id: string; intent: AnnotationIntent; change: "created" | "replied" | "resolved" | "thread" };
};

export type DocsStreamItem = { kind: "open" } | { kind: "change"; event: DocsChangeEvent };

type TreeNode = { name: string; path: string; kind: "dir" | "file" | "bundle"; children?: TreeNode[] };

export type DocsEndpoint = { url: string; token?: string };

export class DocsRequestError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly route: string,
    detail: string,
  ) {
    super(`${method} ${route} -> ${status} ${detail}`);
  }
}

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

export class DocsClient {
  private endpoint: DocsEndpoint | null = null;

  constructor(private readonly resolve: () => Promise<DocsEndpoint>) {}

  /** Re-reads the endpoint. Called before each stream connect, so a restarted daemon's new token is picked up. */
  async refresh(): Promise<DocsEndpoint> {
    this.endpoint = await this.resolve();
    return this.endpoint;
  }

  private async current(): Promise<DocsEndpoint> {
    return this.endpoint ?? (await this.refresh());
  }

  private headers(endpoint: DocsEndpoint, extra: Record<string, string> = {}): Record<string, string> {
    return endpoint.token ? { ...extra, authorization: `Bearer ${endpoint.token}` } : extra;
  }

  private async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const endpoint = await this.current();
    const response = await fetch(`${endpoint.url}${route}`, {
      method,
      headers: this.headers(endpoint, body === undefined ? {} : { "content-type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new DocsRequestError(response.status, method, route, text.slice(0, 300));
    }
    return (await response.json()) as T;
  }

  /** Every doc bundle path in the project, depth first. */
  async bundlePaths(): Promise<string[]> {
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
  async pageTitle(path: string): Promise<string> {
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

  async setThread(path: string, annotationId: string, thread: AnnotationThread, sessionId: string): Promise<void> {
    await this.request("PUT", `/api/annotations/${encodeURIComponent(annotationId)}/thread`, {
      path,
      thread,
      session_id: sessionId,
    });
  }

  async reply(path: string, annotationId: string, body: string, author: string, sessionId: string): Promise<void> {
    await this.request("POST", `/api/annotations/${encodeURIComponent(annotationId)}/replies`, {
      path,
      body,
      author,
      session_id: sessionId,
    });
  }

  /**
   * The SSE change stream. Yields `open` once the server's first frame
   * arrives, then one `change` per event. Returns when the connection closes
   * and throws when it cannot be opened; the caller reconnects.
   */
  async *events(signal: AbortSignal): AsyncGenerator<DocsStreamItem> {
    const endpoint = await this.current();
    const response = await fetch(`${endpoint.url}/api/events`, {
      headers: this.headers(endpoint, { accept: "text/event-stream" }),
      signal,
    });
    if (!response.ok || !response.body) {
      throw new DocsRequestError(response.status, "GET", "/api/events", await response.text().catch(() => ""));
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let opened = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffered += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while ((boundary = buffered.indexOf("\n\n")) !== -1) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          if (!opened) {
            opened = true;
            yield { kind: "open" };
          }
          const event = parseFrame(frame);
          if (event) yield { kind: "change", event };
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}

/** One SSE frame to a change event. Named frames (connected, keepalive) and non-JSON data are skipped. */
function parseFrame(frame: string): DocsChangeEvent | null {
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) return null;
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  const text = data.join("\n");
  if (!text.startsWith("{")) return null;
  try {
    return JSON.parse(text) as DocsChangeEvent;
  } catch {
    return null;
  }
}
