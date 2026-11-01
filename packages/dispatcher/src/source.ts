import type { Surface } from "./config";

/**
 * What the dispatcher needs from one studio surface (docs, canvas, prompt):
 * its request events, its annotation store, and the first message a thread
 * gets. The pending rule, the thread lookup, the t3 calls and the backoff stay
 * in dispatcher.ts and are the same for every surface.
 */

/** The annotation fields the dispatcher reads. Docs, canvas and Prompt Kit annotations all have them. */
export type AnnotationReply = { id: string; author: string; body: string; createdAt?: string };
export type AnnotationThread = { id: string; title?: string };
export type Annotation = {
  id: string;
  body: string;
  intent: string;
  /** `open` means not yet handled. Canvas adds `applied`, which counts as handled. */
  status: string;
  createdAt?: string;
  replies?: AnnotationReply[];
  thread?: AnnotationThread;
};

export type AnnotationChange = "created" | "replied" | "resolved" | "thread";

export type SourceEvent =
  /** The stream is connected. The dispatcher scans, because no stream replays. */
  | { kind: "open" }
  /** One annotation changed on `target`. `actor` is the writer, when the surface reports one. */
  | { kind: "annotation"; target: string; annotationId: string; intent: string; change: AnnotationChange; actor?: string }
  /** Something on `target` changed with no annotation detail, such as a file written outside the API. */
  | { kind: "touched"; target: string };

export type RequestFacts = {
  kind: "created" | "replied";
  /** The source's own key for a page, board or prompt. */
  target: string;
  title: string;
  annotationId: string;
  text: string;
};

export interface Source {
  /** Log prefix, queue namespace and thread title suffix. */
  readonly surface: Surface;
  /** The T3 project that owns this surface's targets. */
  readonly t3Project: string;
  /** One stream connection: re-reads the endpoint and token, yields `open` first. Returns when the stream closes. */
  events(signal: AbortSignal): AsyncGenerator<SourceEvent>;
  /** Every target to scan for pending requests. */
  targets(): Promise<string[]>;
  annotations(target: string): Promise<Annotation[]>;
  /** The page, board or prompt title: the thread title. */
  title(target: string): Promise<string>;
  /** Binds the annotation to a T3 thread. */
  setThread(target: string, annotationId: string, thread: AnnotationThread): Promise<void>;
  /** Posts a `system` reply on the annotation. */
  reply(target: string, annotationId: string, body: string): Promise<void>;
  /** The thread's message: the skill to load, where the request is, and how to answer. */
  message(facts: RequestFacts): string;
}

/** `session_id` or `actor` on every write, so a surface that reports actors lets the dispatcher skip its own events. */
export const DISPATCHER_ACTOR = "dispatcher";
/** Author of the dispatcher's replies. Every studio renders "system" and "agent" as non-human. */
export const SYSTEM_AUTHOR = "system";

/** The lines every thread message ends with. */
export function messageTail(facts: RequestFacts, where: string[]): string[] {
  return [
    "Replies with author \"agent\" stay in the studio and are not sent back to this thread. A human reply on the annotation reaches this thread as a new message.",
    "If your harness does not set T3CODE_THREAD_ID (Codex does not), pass this thread's id as thread_id to canvas_open, docs_begin or prompts_begin, so the action log joins your edits to this thread.",
    "",
    `Annotation: ${facts.annotationId}`,
    ...where,
    "Request:",
    facts.text,
  ];
}

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly route: string,
    detail: string,
  ) {
    super(`${method} ${route} -> ${status} ${detail}`);
  }
}

/**
 * One JSON request. `route` names the request in errors and must hold no
 * secret: the token goes only in `headers`.
 */
export async function requestJson<T>(
  url: string,
  route: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ data: T; response: Response }> {
  const method = init.method ?? "GET";
  const headers = { ...init.headers, ...(init.body === undefined ? {} : { "content-type": "application/json" }) };
  const response = await fetch(url, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new RequestError(response.status, method, route, text.slice(0, 300));
  }
  return { data: (await response.json()) as T, response };
}

/**
 * An SSE stream as parsed JSON payloads. Yields `null` once when the server's
 * first frame arrives (the open signal), then each unnamed `data:` frame.
 * Named frames (connected, keepalive) and non-JSON data are skipped.
 */
export async function* sseJson(url: string, route: string, headers: Record<string, string>, signal: AbortSignal): AsyncGenerator<unknown> {
  const response = await fetch(url, { headers: { ...headers, accept: "text/event-stream" }, signal });
  if (!response.ok || !response.body) {
    throw new RequestError(response.status, "GET", route, (await response.text().catch(() => "")).slice(0, 300));
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
          yield null;
        }
        const payload = parseFrame(frame);
        if (payload !== undefined) yield payload;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function parseFrame(frame: string): unknown {
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) return undefined;
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  const text = data.join("\n");
  if (!text.startsWith("{")) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
