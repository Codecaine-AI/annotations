/**
 * An in-process docs-server double: the annotation routes and the SSE change
 * stream with the shapes of docs-system/packages/docs-server/src/routes.ts,
 * mounted under `/projects/test/api` like the docs daemon mounts them.
 */
import type { Annotation, AnnotationIntent, DocsChangeEvent } from "../src/docs";

type Page = { title: string; annotations: Annotation[] };
type Waiter = { predicate: () => boolean; resolve: () => void };

const PREFIX = "/projects/test";
const encoder = new TextEncoder();

export class FakeDocs {
  readonly pages = new Map<string, Page>();
  readonly url: string;
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private waiters: Waiter[] = [];
  private subscribeWaiters: (() => void)[] = [];
  private counter = 0;

  constructor(pages: Record<string, string>) {
    for (const [path, title] of Object.entries(pages)) this.pages.set(path, { title, annotations: [] });
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => this.handle(request) });
    this.url = `http://127.0.0.1:${this.server.port}${PREFIX}`;
  }

  stop(): void {
    for (const controller of this.subscribers) {
      try {
        controller.close();
      } catch {
        // already closed
      }
    }
    this.server.stop(true);
  }

  annotations(path: string): Annotation[] {
    return this.page(path).annotations;
  }

  annotation(id: string): Annotation {
    for (const page of this.pages.values()) {
      const found = page.annotations.find((item) => item.id === id);
      if (found) return found;
    }
    throw new Error(`no annotation ${id}`);
  }

  /** Resolves when `predicate` holds, checked now and after every store change. */
  whenever(predicate: () => boolean): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ predicate, resolve }));
  }

  /** Resolves once a client has opened the event stream. */
  subscribed(): Promise<void> {
    return new Promise((resolve) => this.subscribeWaiters.push(resolve));
  }

  /** Emits the file watcher's bare change event for a page, as the daemon does for a sidecar written outside the API. */
  touch(path: string): void {
    this.counter += 1;
    this.changed({ path, changedIds: [], patchId: `fs-${this.counter}`, actor: "fs" });
  }

  /** Adds an annotation with no change event, as if it was written while nobody listened. */
  seed(path: string, input: { body: string; intent: AnnotationIntent; author: string; status?: Annotation["status"] }): Annotation {
    const annotation = this.create(path, input);
    this.page(path).annotations.push(annotation);
    return annotation;
  }

  // -- client helpers: the HTTP calls a studio makes -------------------------

  async file(path: string, body: string, author: string): Promise<Annotation> {
    const response = await this.post("/api/annotations", { path, target: { kind: "block", blockId: "b1" }, body, intent: "agent-request", author, session_id: author });
    return ((await response.json()) as { annotation: Annotation }).annotation;
  }

  async reply(path: string, annotationId: string, body: string, author: string): Promise<void> {
    await this.post(`/api/annotations/${annotationId}/replies`, { path, body, author });
  }

  async resolve(path: string, annotationId: string): Promise<void> {
    await this.post(`/api/annotations/${annotationId}/resolve`, { path });
  }

  private async post(route: string, body: unknown): Promise<Response> {
    const response = await fetch(`${this.url}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${route} -> ${response.status} ${await response.text()}`);
    return response;
  }

  // -- server --------------------------------------------------------------

  private page(path: string): Page {
    const page = this.pages.get(path);
    if (!page) throw new Error(`no page ${path}`);
    return page;
  }

  private create(path: string, input: { body: string; intent: AnnotationIntent; author: string; status?: Annotation["status"] }): Annotation {
    this.counter += 1;
    return {
      id: `ann-${this.counter}`,
      body: input.body,
      intent: input.intent,
      author: input.author,
      status: input.status ?? "open",
      createdAt: new Date(1_700_000_000_000 + this.counter * 1000).toISOString(),
      replies: [],
    };
  }

  private changed(event: DocsChangeEvent): void {
    const frame = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const controller of this.subscribers) controller.enqueue(frame);
    const ready = this.waiters.filter((waiter) => waiter.predicate());
    this.waiters = this.waiters.filter((waiter) => !ready.includes(waiter));
    for (const waiter of ready) waiter.resolve();
  }

  private listing(path: string): unknown {
    const page = this.page(path);
    return { annotations: { schemaVersion: 1, annotations: page.annotations }, hash: `hash-${this.counter}` };
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${PREFIX}/api/`)) return new Response("Not found", { status: 404 });
    const route = url.pathname.slice(PREFIX.length);
    const path = url.searchParams.get("path") ?? "";

    if (request.method === "GET" && route === "/api/events") return this.stream();
    if (request.method === "GET" && route === "/api/tree") {
      return Response.json({ tree: [...this.pages.keys()].map((p) => ({ name: p.split("/").at(-1), path: p, kind: "bundle" })) });
    }
    if (request.method === "GET" && route === "/api/bundle") {
      return Response.json({ path, doc: { title: this.page(path).title }, annotations: this.listing(path) });
    }
    if (request.method === "GET" && route === "/api/annotations") return Response.json(this.listing(path));

    const body = (await request.json()) as Record<string, unknown>;
    const bodyPath = String(body.path);
    const actor = typeof body.session_id === "string" ? body.session_id : "anonymous";
    const emit = (annotation: Annotation, change: NonNullable<DocsChangeEvent["annotation"]>["change"]) =>
      this.changed({ path: bodyPath, changedIds: [], patchId: `annotation-${this.counter}`, actor, annotation: { id: annotation.id, intent: annotation.intent, change } });

    if (request.method === "POST" && route === "/api/annotations") {
      const annotation = this.create(bodyPath, body as { body: string; intent: AnnotationIntent; author: string });
      this.page(bodyPath).annotations.push(annotation);
      emit(annotation, "created");
      return Response.json({ annotation, ...(this.listing(bodyPath) as object) }, { status: 201 });
    }
    const match = route.match(/^\/api\/annotations\/([^/]+)\/(replies|resolve|thread)$/);
    if (!match) return new Response("Not found", { status: 404 });
    const annotation = this.page(bodyPath).annotations.find((item) => item.id === match[1]);
    if (!annotation) return Response.json({ detail: `Annotation not found: ${match[1]}` }, { status: 404 });

    if (match[2] === "replies" && request.method === "POST") {
      this.counter += 1;
      annotation.replies = [
        ...(annotation.replies ?? []),
        { id: `reply-${this.counter}`, author: typeof body.author === "string" ? body.author : "anonymous", body: String(body.body), createdAt: new Date(1_700_000_000_000 + this.counter * 1000).toISOString() },
      ];
      emit(annotation, "replied");
      return Response.json(this.listing(bodyPath));
    }
    if (match[2] === "resolve" && request.method === "POST") {
      annotation.status = "resolved";
      emit(annotation, "resolved");
      return Response.json(this.listing(bodyPath));
    }
    if (match[2] === "thread" && request.method === "PUT") {
      const thread = body.thread as { id: string; title?: string } | null;
      if (thread && thread.id.length === 0) return Response.json({ detail: "thread id must not be empty" }, { status: 422 });
      if (thread) annotation.thread = thread;
      else delete annotation.thread;
      emit(annotation, "thread");
      return Response.json({ annotation, ...(this.listing(bodyPath) as object) });
    }
    return new Response("Not found", { status: 404 });
  }

  private stream(): Response {
    const subscribers = this.subscribers;
    let own: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        own = controller;
        subscribers.add(controller);
        controller.enqueue(encoder.encode("event: connected\ndata: ok\n\n"));
        const waiters = this.subscribeWaiters;
        this.subscribeWaiters = [];
        for (const resolve of waiters) resolve();
      },
      cancel: () => {
        subscribers.delete(own);
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }
}
