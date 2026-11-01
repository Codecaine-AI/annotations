/**
 * An in-process Prompt service double: the bearer token check, `/rpc`
 * `prompts_discover`, the annotation routes and `/api/events`, with the shapes
 * of prompt-kit-mcp/src/daemon.ts and prompt-kit-server/src/annotation-routes.ts.
 * It writes its `{ url, token }` state file like the daemon, and `restart`
 * changes the token and drops every stream, as a daemon restart does.
 *
 * Tests can also inject faults (a bind that fails, a prompt that refuses
 * `system` replies) and hook the moment a reply lands.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AnnotationChange, AnnotationReply, AnnotationThread } from "../src/source";

export type PromptAnnotation = {
  id: string;
  target: unknown;
  body: string;
  intent: string;
  author: string;
  status: "open" | "resolved";
  createdAt: string;
  replies?: AnnotationReply[];
  thread?: AnnotationThread;
};
type Prompt = { id: string; title: string; path: string; annotations: PromptAnnotation[] };
type Waiter = { predicate: () => boolean; resolve: () => void };

const encoder = new TextEncoder();

export class FakePromptService {
  token = randomBytes(32).toString("hex");
  /** Every token this service has used. */
  readonly tokens: string[] = [this.token];
  readonly prompts = new Map<string, Prompt>();
  readonly url: string;
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private waiters: Waiter[] = [];
  private subscribeWaiters: (() => void)[] = [];
  private counter = 0;
  unauthorized = 0;
  /** Called before a reply is appended, with the annotation and the reply body. A test uses it to act inside a dispatch's window. */
  beforeReply: ((annotation: PromptAnnotation, body: string) => void) | null = null;
  /** How many thread binds this server has refused so far. */
  rejectedBinds = 0;
  private bindFailuresLeft = 0;
  private readonly refusingReplies = new Set<string>();
  private readonly refusedRepliesAt = new Map<string, number[]>();

  constructor(
    readonly root: string,
    readonly stateFile: string,
    prompts: { id: string; title: string; path: string }[],
  ) {
    for (const prompt of prompts) this.prompts.set(prompt.path, { ...prompt, annotations: [] });
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => this.handle(request) });
    this.url = `http://127.0.0.1:${this.server.port}`;
    this.writeState();
  }

  /** The dispatcher's target for a prompt path. */
  target(path: string): string {
    return join(this.root, path);
  }

  stop(): void {
    this.closeStreams();
    this.server.stop(true);
  }

  /** A new token in the state file, and every open stream closed. */
  restart(): void {
    this.token = randomBytes(32).toString("hex");
    this.tokens.push(this.token);
    this.writeState();
    this.closeStreams();
  }

  annotation(id: string): PromptAnnotation {
    for (const prompt of this.prompts.values()) {
      const found = prompt.annotations.find((item) => item.id === id);
      if (found) return found;
    }
    throw new Error(`no annotation ${id}`);
  }

  whenever(predicate: () => boolean): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ predicate, resolve }));
  }

  subscribed(): Promise<void> {
    return new Promise((resolve) => this.subscribeWaiters.push(resolve));
  }

  seed(path: string, input: { body: string; intent?: string; status?: PromptAnnotation["status"] }): PromptAnnotation {
    const annotation = this.create(input.body, input.intent ?? "agent-request", "ford", input.status);
    this.prompt(path).annotations.push(annotation);
    return annotation;
  }

  /** Appends a reply and emits its event without an HTTP round trip, for use inside `beforeReply`. */
  inject(path: string, annotationId: string, body: string, author: string): void {
    const annotation = this.prompt(path).annotations.find((item) => item.id === annotationId);
    if (!annotation) throw new Error(`no annotation ${annotationId} on ${path}`);
    this.addReply(path, annotation, body, author);
  }

  // -- faults and counters -----------------------------------------------------

  /** The next `count` thread binds answer 500. */
  failNextBinds(count: number): void {
    this.bindFailuresLeft = count;
  }

  /** `system` replies on this prompt answer 500 from now on. */
  refuseReplies(path: string): void {
    this.refusingReplies.add(path);
  }

  /** When each refused `system` reply on the prompt arrived, in ms. */
  refusedReplies(path: string): number[] {
    return this.refusedRepliesAt.get(path) ?? [];
  }

  // -- client helpers: the calls Prompt Studio proxies ---------------------------

  async file(path: string, body: string): Promise<PromptAnnotation> {
    const response = await this.call("POST", "", path, { target: { kind: "node", id: "$root" }, body, intent: "agent-request", author: "ford" });
    return ((await response.json()) as { annotation: PromptAnnotation }).annotation;
  }

  async reply(path: string, annotationId: string, body: string, author: string): Promise<void> {
    await this.call("POST", `/${annotationId}/replies`, path, { body, author });
  }

  async resolve(path: string, annotationId: string): Promise<void> {
    await this.call("POST", `/${annotationId}/resolve`, path, { actor: "agent" });
  }

  private async call(method: string, action: string, path: string, body: unknown): Promise<Response> {
    const route = `/api/annotations${action}?root=${encodeURIComponent(this.root)}&path=${encodeURIComponent(path)}`;
    const response = await fetch(`${this.url}${route}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${route} -> ${response.status} ${await response.text()}`);
    return response;
  }

  // -- server ------------------------------------------------------------------

  private writeState(): void {
    writeFileSync(this.stateFile, JSON.stringify({ url: this.url, token: this.token, pid: process.pid, packageRoot: "/fake", startedAt: new Date().toISOString() }));
  }

  private closeStreams(): void {
    for (const controller of this.subscribers) {
      try {
        controller.close();
      } catch {
        // already closed
      }
    }
    this.subscribers.clear();
  }

  private prompt(path: string): Prompt {
    const prompt = this.prompts.get(path);
    if (!prompt) throw new Error(`no prompt ${path}`);
    return prompt;
  }

  private create(body: string, intent: string, author: string, status: PromptAnnotation["status"] = "open"): PromptAnnotation {
    this.counter += 1;
    return { id: `ann-${this.counter}`, target: { kind: "node", id: "$root" }, body, intent, author, status, createdAt: new Date(1_700_000_000_000 + this.counter * 1000).toISOString() };
  }

  private emit(path: string, annotation: PromptAnnotation, change: AnnotationChange, actor: string): void {
    const event = { root: this.root, path, annotationId: annotation.id, change, intent: annotation.intent, status: annotation.status, thread: annotation.thread ?? null, hash: `pka1-${this.counter}`, actor };
    const frame = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const controller of this.subscribers) controller.enqueue(frame);
    this.wake();
  }

  private wake(): void {
    const ready = this.waiters.filter((waiter) => waiter.predicate());
    this.waiters = this.waiters.filter((waiter) => !ready.includes(waiter));
    for (const waiter of ready) waiter.resolve();
  }

  private addReply(path: string, annotation: PromptAnnotation, body: string, author: string): void {
    this.counter += 1;
    annotation.replies = [...(annotation.replies ?? []), { id: `reply-${this.counter}`, author, body, createdAt: new Date().toISOString() }];
    this.emit(path, annotation, "replied", author);
  }

  private async handle(request: Request): Promise<Response> {
    const response = await this.route(request);
    this.wake();
    return response;
  }

  private async route(request: Request): Promise<Response> {
    if (request.headers.get("authorization") !== `Bearer ${this.token}`) {
      this.unauthorized += 1;
      return new Response("Unauthorized", { status: 401 });
    }
    const url = new URL(request.url);
    if (url.pathname === "/api/events" && request.method === "GET") return this.stream();
    if (url.pathname === "/rpc" && request.method === "POST") {
      const call = (await request.json()) as { name: string };
      if (call.name !== "prompts_discover") return Response.json({ structuredContent: { ok: false, detail: "unknown tool" }, isError: true });
      const prompts = [...this.prompts.values()].map(({ id, title, path }) => ({ id, title, target: { promptPath: path } }));
      return Response.json({ structuredContent: { ok: true, workspace: this.root, projects: [{ id: "fake", name: "Fake", root: this.root, prompts }] } });
    }
    const match = url.pathname.match(/^\/api\/annotations(?:\/([^/]+)\/(replies|resolve|thread))?$/);
    if (!match) return new Response("Not found", { status: 404 });
    if (url.searchParams.get("root") !== this.root) return Response.json({ detail: "unknown root" }, { status: 400 });
    const path = url.searchParams.get("path") ?? "";
    const prompt = this.prompts.get(path);
    if (!prompt) return Response.json({ detail: `prompt not found: ${path}` }, { status: 404 });
    const snapshot = () => ({ path, annotations: prompt.annotations, hash: `pka1-${this.counter}` });
    if (!match[1] && request.method === "GET") return Response.json(snapshot());
    const body = (await request.json()) as Record<string, unknown>;
    if (!match[1] && request.method === "POST") {
      const annotation = this.create(String(body.body), String(body.intent), String(body.author));
      prompt.annotations.push(annotation);
      this.emit(path, annotation, "created", annotation.author);
      return Response.json({ annotation, ...snapshot() }, { status: 201 });
    }
    const annotation = prompt.annotations.find((item) => item.id === decodeURIComponent(match[1] ?? ""));
    if (!annotation) return Response.json({ detail: "annotation not found" }, { status: 404 });
    if (match[2] === "replies" && request.method === "POST") {
      const author = typeof body.author === "string" ? body.author : "anonymous";
      const replyBody = String(body.body);
      if (author === "system" && this.refusingReplies.has(path)) {
        this.refusedRepliesAt.set(path, [...this.refusedReplies(path), Date.now()]);
        return Response.json({ detail: "Injected failure" }, { status: 500 });
      }
      this.beforeReply?.(annotation, replyBody);
      this.addReply(path, annotation, replyBody, author);
      return Response.json({ annotation, ...snapshot() });
    }
    if (match[2] === "resolve" && request.method === "POST") {
      annotation.status = "resolved";
      this.emit(path, annotation, "resolved", typeof body.actor === "string" ? body.actor : "unknown");
      return Response.json({ annotation, ...snapshot() });
    }
    if (match[2] === "thread" && request.method === "PUT") {
      if (this.bindFailuresLeft > 0) {
        this.bindFailuresLeft -= 1;
        this.rejectedBinds += 1;
        return Response.json({ detail: "Injected failure" }, { status: 500 });
      }
      const thread = body.thread as AnnotationThread | null;
      if (thread) annotation.thread = thread;
      else delete annotation.thread;
      this.emit(path, annotation, "thread", typeof body.actor === "string" ? body.actor : "unknown");
      return Response.json({ annotation, ...snapshot() });
    }
    return Response.json({ detail: "method not allowed" }, { status: 405 });
  }

  private stream(): Response {
    let own: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        own = controller;
        this.subscribers.add(controller);
        controller.enqueue(encoder.encode("event: connected\ndata: ok\n\n"));
        const waiters = this.subscribeWaiters;
        this.subscribeWaiters = [];
        for (const resolve of waiters) resolve();
      },
      cancel: () => {
        this.subscribers.delete(own);
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }
}
