/**
 * An in-process Canvas Studio file API double: the board routes with If-Match
 * and the annotation event stream, with the shapes of the canvas repo's
 * packages/studio/server/canvas-file-api.ts and canvas-annotation-events.ts.
 * Like the real hub, every save diffs the board's annotations and emits one
 * event per change, with no actor, whoever wrote it.
 *
 * Tests can also inject faults (a bind that fails, a board that refuses the
 * dispatcher's replies) and hook the moment a dispatcher reply is saved.
 */
import { createHash } from "node:crypto";

import type { AnnotationChange, AnnotationReply, AnnotationThread } from "../src/source";

export type CanvasAnnotation = {
  id: string;
  target: { kind: "region"; region: { x: number; y: number; width: number; height: number } };
  intent: "note" | "agent-request";
  body: string;
  status: "open" | "applied" | "resolved";
  createdBy: "human" | "agent" | "system";
  createdAt?: string;
  replies: AnnotationReply[];
  thread?: AnnotationThread;
};
type Board = { schemaVersion: 1; id: string; title?: string; annotations: CanvasAnnotation[]; viewport: { x: number; y: number; zoom: number } };
type Waiter = { predicate: () => boolean; resolve: () => void };

const encoder = new TextEncoder();

export class FakeCanvasStudio {
  readonly boards = new Map<string, Board>();
  readonly url: string;
  readonly dir = "/canvases";
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private waiters: Waiter[] = [];
  private subscribeWaiters: (() => void)[] = [];
  private counter = 0;
  /** Board ids whose next thread write meets a Studio save that landed first. */
  private readonly conflicts = new Set<string>();
  conflictsServed = 0;
  /** Called before a board save that adds a `system` reply, with the annotation and the reply body. A test uses it to act inside a dispatch's window. */
  beforeReply: ((annotation: CanvasAnnotation, body: string) => void) | null = null;
  /** How many thread binds this server has refused so far. */
  rejectedBinds = 0;
  private bindFailuresLeft = 0;
  private readonly refusingReplies = new Set<string>();
  private readonly refusedRepliesAt = new Map<string, number[]>();

  constructor(boards: Record<string, string>) {
    for (const [id, title] of Object.entries(boards)) {
      this.boards.set(id, { schemaVersion: 1, id, title, annotations: [], viewport: { x: 0, y: 0, zoom: 1 } });
    }
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => this.handle(request) });
    this.url = `http://127.0.0.1:${this.server.port}`;
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

  annotation(id: string): CanvasAnnotation {
    for (const board of this.boards.values()) {
      const found = board.annotations.find((item) => item.id === id);
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

  /** The next thread binding on `boardId` finds that another save landed after the dispatcher read the board. */
  conflictNext(boardId: string): void {
    this.conflicts.add(boardId);
  }

  /** Adds an annotation with no event, as if Studio saved it while nobody listened. */
  seed(boardId: string, input: { body: string; intent?: CanvasAnnotation["intent"]; status?: CanvasAnnotation["status"] }): CanvasAnnotation {
    const annotation = this.create(input.body, input.intent ?? "agent-request", input.status);
    this.board(boardId).annotations.push(annotation);
    return annotation;
  }

  /** Saves a reply and emits its event without an HTTP round trip, for use inside `beforeReply`. */
  inject(boardId: string, annotationId: string, body: string, author: CanvasAnnotation["createdBy"]): void {
    this.counter += 1;
    const reply = { id: `human-reply-${this.counter}`, author, body, createdAt: this.stamp() };
    const board = this.board(boardId);
    this.save(boardId, {
      ...board,
      annotations: board.annotations.map((item) => (item.id === annotationId ? { ...item, replies: [...item.replies, reply] } : item)),
    });
  }

  // -- faults and counters -----------------------------------------------------

  /** The next `count` thread binds answer 500. */
  failNextBinds(count: number): void {
    this.bindFailuresLeft = count;
  }

  /** Board saves that add a `system` reply on this board answer 500 from now on. */
  refuseReplies(boardId: string): void {
    this.refusingReplies.add(boardId);
  }

  /** When each refused `system` reply save on the board arrived, in ms. */
  refusedReplies(boardId: string): number[] {
    return this.refusedRepliesAt.get(boardId) ?? [];
  }

  // -- client helpers: the saves Canvas Studio makes ---------------------------

  /** Files a request the way the Studio page does: a whole-board PUT with the new annotation. */
  async file(boardId: string, body: string): Promise<CanvasAnnotation> {
    const annotation = this.create(body, "agent-request");
    await this.edit(boardId, (board) => ({ ...board, annotations: [...board.annotations, annotation] }));
    return annotation;
  }

  async reply(boardId: string, annotationId: string, body: string, author: CanvasAnnotation["createdBy"]): Promise<void> {
    this.counter += 1;
    const reply = { id: `human-reply-${this.counter}`, author, body, createdAt: this.stamp() };
    await this.edit(boardId, (board) => ({
      ...board,
      annotations: board.annotations.map((item) => (item.id === annotationId ? { ...item, replies: [...item.replies, reply] } : item)),
    }));
  }

  async resolve(boardId: string, annotationId: string): Promise<void> {
    await this.edit(boardId, (board) => ({
      ...board,
      annotations: board.annotations.map((item) => (item.id === annotationId ? { ...item, status: "resolved" as const } : item)),
    }));
  }

  private async edit(boardId: string, change: (board: Board) => Board): Promise<void> {
    const read = (await (await fetch(`${this.url}/api/canvases/${boardId}`)).json()) as { contentHash: string; canvas: Board };
    const response = await fetch(`${this.url}/api/canvases/${boardId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": `"${read.contentHash}"` },
      body: JSON.stringify({ canvas: change(read.canvas) }),
    });
    if (!response.ok) throw new Error(`PUT ${boardId} -> ${response.status} ${await response.text()}`);
  }

  // -- server ------------------------------------------------------------------

  private board(id: string): Board {
    const board = this.boards.get(id);
    if (!board) throw new Error(`no board ${id}`);
    return board;
  }

  private stamp(): string {
    return new Date(1_700_000_000_000 + this.counter * 1000).toISOString();
  }

  private create(body: string, intent: CanvasAnnotation["intent"], status: CanvasAnnotation["status"] = "open"): CanvasAnnotation {
    this.counter += 1;
    return {
      id: `ann-${this.counter}`,
      target: { kind: "region", region: { x: 0, y: 0, width: 100, height: 100 } },
      intent,
      body,
      status,
      createdBy: "human",
      createdAt: this.stamp(),
      replies: [],
    };
  }

  private bytes(board: Board): string {
    return `${JSON.stringify(board, null, 2)}\n`;
  }

  private hash(board: Board): string {
    return createHash("sha256").update(this.bytes(board)).digest("hex");
  }

  /** Saves the board and emits one event per annotation change, as canvas-annotation-events.ts does. */
  private save(id: string, next: Board): void {
    const before = new Map(this.board(id).annotations.map((item) => [item.id, item]));
    this.boards.set(id, next);
    for (const annotation of next.annotations) {
      const old = before.get(annotation.id);
      const changes: AnnotationChange[] = [];
      if (!old) changes.push("created");
      else {
        if (annotation.replies.length > old.replies.length) changes.push("replied");
        if (old.status === "open" && annotation.status !== "open") changes.push("resolved");
        if (old.thread?.id !== annotation.thread?.id) changes.push("thread");
      }
      for (const change of changes) {
        const event = { path: `${this.dir}/${id}.canvas.json`, canvasId: id, annotation: { id: annotation.id, intent: annotation.intent, change } };
        const frame = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
        for (const controller of this.subscribers) controller.enqueue(frame);
      }
    }
    this.wake();
  }

  private wake(): void {
    const ready = this.waiters.filter((waiter) => waiter.predicate());
    this.waiters = this.waiters.filter((waiter) => !ready.includes(waiter));
    for (const waiter of ready) waiter.resolve();
  }

  /** The first `system` reply that `next` adds to the board as stored. */
  private addedSystemReply(id: string, next: Board): { annotation: CanvasAnnotation; body: string } | null {
    const before = new Map(this.board(id).annotations.map((item) => [item.id, item.replies.length]));
    for (const annotation of next.annotations) {
      const added = annotation.replies.slice(before.get(annotation.id) ?? 0).find((reply) => reply.author === "system");
      if (added) return { annotation, body: added.body };
    }
    return null;
  }

  /** 412 unless If-Match names the current revision. A pending conflict first lands another save. */
  private stale(request: Request, id: string, thread = false): Response | null {
    if (thread && this.conflicts.delete(id)) {
      const board = this.board(id);
      this.save(id, { ...board, viewport: { ...board.viewport, x: board.viewport.x + 1 } });
      this.conflictsServed += 1;
    }
    const current = this.hash(this.board(id));
    const ifMatch = request.headers.get("if-match");
    if (ifMatch && ifMatch !== `"${current}"`) return Response.json({ error: "Canvas changed on disk since it was loaded.", currentHash: current }, { status: 412 });
    return null;
  }

  private async handle(request: Request): Promise<Response> {
    const response = await this.route(request);
    this.wake();
    return response;
  }

  private async route(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/api/canvas-annotation-events") return this.stream();
    if (request.method === "GET" && pathname === "/api/canvases") {
      return Response.json({ canvases: [...this.boards.values()].map((board) => ({ id: board.id, title: board.title ?? board.id })) });
    }
    const match = pathname.match(/^\/api\/canvases\/([^/]+)(?:\/annotations\/([^/]+)\/thread)?$/);
    if (!match?.[1] || !this.boards.has(match[1])) return Response.json({ error: "Not found." }, { status: 404 });
    const id = match[1];
    if (match[2]) {
      if (request.method !== "PUT") return Response.json({ error: "Method not allowed." }, { status: 405 });
      const { thread } = (await request.json()) as { thread: AnnotationThread | null };
      if (this.bindFailuresLeft > 0) {
        this.bindFailuresLeft -= 1;
        this.rejectedBinds += 1;
        return Response.json({ error: "Injected failure." }, { status: 500 });
      }
      const stale = this.stale(request, id, true);
      if (stale) return stale;
      const board = this.board(id);
      if (!board.annotations.some((item) => item.id === match[2])) return Response.json({ error: "Annotation not found." }, { status: 404 });
      this.save(id, {
        ...board,
        annotations: board.annotations.map((item) => {
          if (item.id !== match[2]) return item;
          const { thread: _old, ...rest } = item;
          return thread ? { ...rest, thread } : rest;
        }),
      });
      return Response.json({ id, contentHash: this.hash(this.board(id)) });
    }
    if (request.method === "GET") {
      const board = this.board(id);
      return new Response(`{"id":${JSON.stringify(id)},"contentHash":"${this.hash(board)}","canvas":${this.bytes(board)}}\n`, {
        headers: { "content-type": "application/json", etag: `"${this.hash(board)}"` },
      });
    }
    if (request.method === "PUT") {
      const { canvas } = (await request.json()) as { canvas: Board };
      const added = this.addedSystemReply(id, canvas);
      if (added && this.refusingReplies.has(id)) {
        this.refusedRepliesAt.set(id, [...this.refusedReplies(id), Date.now()]);
        return Response.json({ error: "Injected failure." }, { status: 500 });
      }
      if (added) this.beforeReply?.(added.annotation, added.body);
      const stale = this.stale(request, id);
      if (stale) return stale;
      this.save(id, canvas);
      return Response.json({ id, contentHash: this.hash(canvas) });
    }
    return Response.json({ error: "Method not allowed." }, { status: 405 });
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
