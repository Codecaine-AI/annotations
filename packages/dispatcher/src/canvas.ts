/**
 * The canvas surface: standalone boards served by Canvas Studio's file API
 * (canvas repo, packages/studio/server/canvas-file-api.ts and
 * canvas-annotation-events.ts). Writes carry If-Match with the board's
 * content hash, so the dispatcher never overwrites a save it has not read.
 */
import {
  messageTail,
  RequestError,
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

type CanvasAnnotationEvent = { path: string; canvasId: string; annotation: { id: string; intent: string; change: AnnotationChange } };
type Board = { title?: string; annotations?: Annotation[] } & Record<string, unknown>;
type BoardRead = { id: string; contentHash: string; canvas: Board };

/** Tries a hash-guarded write this many times when another writer moved the board in between. */
const WRITE_ATTEMPTS = 3;

/** Targets are board ids, the file name without `.canvas.json`. */
export class CanvasSource implements Source {
  readonly surface = "canvas";
  /** Board files seen on the stream, so the message can name the file. */
  private readonly files = new Map<string, string>();

  constructor(
    private readonly studioUrl: string,
    readonly t3Project: string,
  ) {}

  private url(route: string): string {
    return `${this.studioUrl.replace(/\/+$/, "")}${route}`;
  }

  private async read(id: string): Promise<BoardRead> {
    const route = `/api/canvases/${encodeURIComponent(id)}`;
    return (await requestJson<BoardRead>(this.url(route), route)).data;
  }

  /** Reads the board, applies `write` at that revision, and reads again when another save landed first (412). */
  private async guarded(id: string, write: (board: BoardRead) => Promise<void>): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await write(await this.read(id));
      } catch (error) {
        if (!(error instanceof RequestError && error.status === 412) || attempt >= WRITE_ATTEMPTS) throw error;
      }
    }
  }

  async targets(): Promise<string[]> {
    const { data } = await requestJson<{ canvases: { id: string }[] }>(this.url("/api/canvases"), "/api/canvases");
    return data.canvases.map((board) => board.id);
  }

  async annotations(id: string): Promise<Annotation[]> {
    return (await this.read(id)).canvas.annotations ?? [];
  }

  async title(id: string): Promise<string> {
    const title = (await this.read(id)).canvas.title;
    return typeof title === "string" && title.trim().length > 0 ? title.trim() : id;
  }

  async setThread(id: string, annotationId: string, thread: AnnotationThread): Promise<void> {
    const route = `/api/canvases/${encodeURIComponent(id)}/annotations/${encodeURIComponent(annotationId)}/thread`;
    await this.guarded(id, async ({ contentHash }) => {
      await requestJson(this.url(route), route, { method: "PUT", headers: { "if-match": `"${contentHash}"` }, body: { thread } });
    });
  }

  /** Canvas has no reply route: append the reply to the board and save it at the revision read. */
  async reply(id: string, annotationId: string, body: string): Promise<void> {
    const route = `/api/canvases/${encodeURIComponent(id)}`;
    await this.guarded(id, async ({ contentHash, canvas }) => {
      const annotations = (canvas.annotations ?? []).map((annotation) => {
        if (annotation.id !== annotationId) return annotation;
        const replies = annotation.replies ?? [];
        const reply = { id: nextReplyId(replies.map((item) => item.id)), author: SYSTEM_AUTHOR, body, createdAt: new Date().toISOString() };
        return { ...annotation, replies: [...replies, reply] };
      });
      await requestJson(this.url(route), route, {
        method: "PUT",
        headers: { "if-match": `"${contentHash}"` },
        body: { canvas: { ...canvas, annotations } },
      });
    });
  }

  async *events(signal: AbortSignal): AsyncGenerator<SourceEvent> {
    const route = "/api/canvas-annotation-events";
    for await (const payload of sseJson(this.url(route), route, {}, signal)) {
      if (payload === null) {
        yield { kind: "open" };
        continue;
      }
      const { path, canvasId, annotation } = payload as CanvasAnnotationEvent;
      this.files.set(canvasId, path);
      yield { kind: "annotation", target: canvasId, annotationId: annotation.id, intent: annotation.intent, change: annotation.change };
    }
  }

  message(facts: RequestFacts): string {
    const file = this.files.get(facts.target);
    const lead =
      facts.kind === "created"
        ? `A human filed a request on the board "${facts.title}" (${facts.target}).`
        : `A human replied on the board "${facts.title}" (${facts.target}).`;
    return [
      "Load the canvas skill before you start.",
      "",
      lead,
      `Open the board with canvas_open (canvas id "${facts.target}"${file ? ` or file ${file}` : ""}), do the work, then answer through the canvas MCP request tools: reply with reply_annotation using id "${facts.annotationId}", and close the request with resolve_request when it is done.`,
      ...messageTail(facts, [`Board: ${facts.target}`, ...(file ? [`File: ${file}`] : [])]),
    ].join("\n");
  }
}

/** The canvas reply id grammar: `reply-<n>`, the first unused n. */
function nextReplyId(ids: string[]): string {
  const used = new Set(ids);
  let index = 1;
  while (used.has(`reply-${index}`)) index += 1;
  return `reply-${index}`;
}
