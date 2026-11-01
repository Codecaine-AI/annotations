import type { Annotation, DocsClient } from "./docs";
import type { T3 } from "./t3";

/** `session_id` on every write, so the dispatcher's own change events carry this actor and are skipped. */
export const DISPATCHER_ACTOR = "dispatcher";
/** Author of the dispatcher's replies. The Lab renders "system" and "agent" as non-human. */
export const SYSTEM_AUTHOR = "system";
/** Every dispatcher reply starts with this, so the annotation itself records that its request reached a thread. */
export const MARKER = "Sent to T3 thread";
export const SKILL = "docs-system";

export type Role = "human" | "agent" | "system";

/** The docs-kernel convention: `agent` and `system` are machine authors, everything else is a person. */
export function roleOf(author: string): Role {
  return author === "agent" || author === "system" ? author : "human";
}

export type PendingRequest = { kind: "created" | "replied"; text: string };

/**
 * The request on an annotation that no thread has received yet, derived only
 * from the annotation's own replies.
 *
 * - No dispatcher marker yet: an open request is new, and its text is the body
 *   plus any human replies so far. A resolved one without a marker was handled
 *   some other way and is left alone.
 * - A marker exists: human replies after the last agent or system reply are
 *   the follow-up. None means nothing is pending.
 */
export function pendingRequest(annotation: Annotation): PendingRequest | null {
  if (annotation.intent !== "agent-request") return null;
  const replies = annotation.replies ?? [];
  const lastHandled = replies.findLastIndex((reply) => roleOf(reply.author) !== "human");
  const unforwarded = replies.slice(lastHandled + 1).map((reply) => reply.body);
  const dispatched = replies.some((reply) => roleOf(reply.author) === "system" && reply.body.startsWith(MARKER));
  if (!dispatched) {
    if (annotation.status !== "open") return null;
    return { kind: "created", text: [annotation.body, ...unforwarded].join("\n\n") };
  }
  if (unforwarded.length === 0) return null;
  return { kind: "replied", text: unforwarded.join("\n\n") };
}

export type RequestFacts = { kind: PendingRequest["kind"]; path: string; title: string; annotationId: string; text: string };

/** The message a thread gets: the skill to load, the annotation id, the page path, the request, and how to answer. */
export function threadMessage(facts: RequestFacts): string {
  const lead =
    facts.kind === "created"
      ? `A human filed a request on the docs page "${facts.title}" (${facts.path}).`
      : `A human replied on the docs page "${facts.title}" (${facts.path}).`;
  return [
    `Load the ${SKILL} skill before you start.`,
    "",
    lead,
    `Read the page with the docs MCP tools, do the work, then answer through the docs MCP annotation tools: reply with docs_annotation_reply using author "agent" and annotation_id "${facts.annotationId}", and resolve the annotation with docs_annotation_resolve when the request is done.`,
    `Replies with author "agent" stay in the Lab and are not sent back to this thread. A human reply on the annotation reaches this thread as a new message.`,
    "",
    `Annotation: ${facts.annotationId}`,
    `Page: ${facts.path}`,
    "Request:",
    facts.text,
  ].join("\n");
}

export type DispatcherDeps = {
  docs: DocsClient;
  t3: T3;
  t3Project: string;
  log: (line: string) => void;
  /** Delay before a failed request is tried again. */
  retryMs?: number;
  /** Delay between reconnect attempts when the stream drops. */
  reconnectMs?: number;
};

type Key = string;
type Target = { path: string; annotationId: string };

const MAX_RETRY_MS = 5 * 60_000;

/**
 * One loop: subscribe to the docs change stream, scan the corpus on every
 * (re)connect because the stream has no replay, and hand each pending request
 * to its page's T3 thread. All state lives in the annotation store.
 */
export class Dispatcher {
  private readonly queue = new Map<Key, Target>();
  /** Consecutive failures per annotation, so a persistent error backs off instead of retrying every few seconds. */
  private readonly failures = new Map<Key, number>();
  private draining = false;
  private readonly retryMs: number;
  private readonly reconnectMs: number;

  constructor(private readonly deps: DispatcherDeps) {
    this.retryMs = deps.retryMs ?? 5_000;
    this.reconnectMs = deps.reconnectMs ?? 2_000;
  }

  /** Runs until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.deps.docs.refresh();
        for await (const item of this.deps.docs.events(signal)) {
          if (item.kind === "open") {
            this.deps.log("stream open");
            void this.scan().catch((error) => this.deps.log(`scan failed: ${message(error)}`));
            continue;
          }
          const { annotation, actor, path } = item.event;
          if (actor === DISPATCHER_ACTOR) continue;
          if (!annotation) {
            // A plain change event, such as the file watcher's, says only which
            // page changed. Re-reading its annotations covers requests written
            // outside the API, for instance through the docs MCP in another process.
            if (path) void this.checkPage(path).catch((error) => this.deps.log(`check ${path} failed: ${message(error)}`));
            continue;
          }
          if (annotation.intent !== "agent-request") continue;
          if (annotation.change !== "created" && annotation.change !== "replied") continue;
          this.deps.log(`event ${annotation.change} ${path} ${annotation.id} by ${actor}`);
          this.enqueue({ path, annotationId: annotation.id });
        }
        if (!signal.aborted) this.deps.log("stream closed");
      } catch (error) {
        if (!signal.aborted) this.deps.log(`stream error: ${message(error)}`);
      }
      if (!signal.aborted) await sleep(this.reconnectMs, signal);
    }
  }

  /** Enqueues every annotation with a pending request, across the whole project. */
  async scan(): Promise<void> {
    const paths = await this.deps.docs.bundlePaths();
    let found = 0;
    const pool = 8;
    for (let index = 0; index < paths.length; index += pool) {
      const counts = await Promise.all(paths.slice(index, index + pool).map((path) => this.checkPage(path)));
      found += counts.reduce((sum, count) => sum + count, 0);
    }
    this.deps.log(`scan done: ${paths.length} pages, ${found} pending`);
  }

  /** Enqueues the page's pending requests and returns how many there were. */
  private async checkPage(path: string): Promise<number> {
    const annotations = await this.deps.docs.annotations(path);
    let found = 0;
    for (const annotation of annotations) {
      if (!pendingRequest(annotation)) continue;
      found += 1;
      this.enqueue({ path, annotationId: annotation.id });
    }
    return found;
  }

  private enqueue(target: Target): void {
    this.queue.set(`${target.path}\u0000${target.annotationId}`, target);
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.queue.size > 0) {
        const [key, target] = this.queue.entries().next().value as [Key, Target];
        this.queue.delete(key);
        try {
          await this.dispatch(target);
          this.failures.delete(key);
        } catch (error) {
          const failures = (this.failures.get(key) ?? 0) + 1;
          this.failures.set(key, failures);
          const delay = Math.min(this.retryMs * 2 ** (failures - 1), MAX_RETRY_MS);
          this.deps.log(`dispatch ${target.path} ${target.annotationId} failed (${failures}x), retry in ${delay}ms: ${message(error)}`);
          setTimeout(() => this.enqueue(target), delay);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Reads the annotation fresh and, when a request is pending, sends it to the page's live thread. */
  private async dispatch({ path, annotationId }: Target): Promise<void> {
    const { docs, t3, t3Project, log } = this.deps;
    const annotations = await docs.annotations(path);
    const annotation = annotations.find((item) => item.id === annotationId);
    if (!annotation) return;
    const pending = pendingRequest(annotation);
    if (!pending) return;

    const title = await docs.pageTitle(path);
    const facts: RequestFacts = { kind: pending.kind, path, title, annotationId, text: pending.text };
    const existing = await this.liveThread(annotations, title);

    let threadId: string;
    if (existing) {
      threadId = existing.id;
      if (annotation.thread?.id !== threadId) await docs.setThread(path, annotationId, { id: threadId, title }, DISPATCHER_ACTOR);
      await t3.send(threadId, threadMessage(facts));
      log(`sent ${pending.kind} ${path} ${annotationId} -> thread ${threadId}`);
    } else {
      threadId = await t3.start(t3Project, title, threadMessage(facts));
      log(`started thread ${threadId} "${title}" for ${path} ${annotationId}`);
      await docs.setThread(path, annotationId, { id: threadId, title }, DISPATCHER_ACTOR);
    }
    await docs.reply(path, annotationId, `${MARKER} "${title}" (t3-thread://v1/${threadId}).`, SYSTEM_AUTHOR, DISPATCHER_ACTOR);
  }

  /**
   * The page's thread: the newest `thread` field among its annotations when
   * `t3 thread show` confirms it, else a project thread titled after the page.
   */
  private async liveThread(annotations: Annotation[], title: string): Promise<{ id: string; title: string } | null> {
    const newest = annotations
      .filter((item) => item.thread)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.thread;
    if (newest) {
      if ((await this.deps.t3.show(newest.id)) === "alive") return { id: newest.id, title: newest.title ?? title };
      this.deps.log(`thread ${newest.id} is gone`);
    }
    const listed = (await this.deps.t3.list(this.deps.t3Project)).find((thread) => thread.title === title);
    return listed ? { id: listed.threadId, title: listed.title } : null;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
