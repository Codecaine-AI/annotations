import type { Annotation, AnnotationReply, DocsClient } from "./docs";
import type { T3 } from "./t3";

/** `session_id` on every write, so the dispatcher's own change events carry this actor and are skipped. */
export const DISPATCHER_ACTOR = "dispatcher";
/** Author of the dispatcher's replies. The Lab renders "system" and "agent" as non-human. */
export const SYSTEM_AUTHOR = "system";
/** Completion marker: the turn is in the thread and the annotation records which replies it carried. */
export const MARKER = "Sent to T3 thread";
/** In-flight marker, written before the T3 call, so a crash between the two leaves a record with the delivery's identity. */
export const SENDING_MARKER = "Sending to T3";
export const SKILL = "docs-system";

export type Role = "human" | "agent" | "system";

/** The docs-kernel convention: `agent` and `system` are machine authors, everything else is a person. */
export function roleOf(author: string): Role {
  return author === "agent" || author === "system" ? author : "human";
}

/**
 * One turn for a thread. `delivered` is the delivery's identity on this
 * annotation: the id of the newest human reply it carries, or `request` when it
 * carries the annotation body alone.
 */
export type Delivery = { kind: "created" | "replied"; text: string; delivered: string };

/**
 * Where an annotation stands: nothing to do, a delivery with a `Sending`
 * marker and no `Sent` marker after it (`threadId` is set when the marker
 * named a thread), or the next delivery to record and send.
 */
export type DeliveryState =
  | { kind: "idle" }
  | { kind: "in-flight"; delivery: Delivery; threadId: string | null }
  | { kind: "pending"; delivery: Delivery };

type Marker = { state: "sending" | "sent"; delivered: string | null; threadId: string | null; index: number };

const THREAD_IN_MARKER = /\(t3-thread:\/\/v1\/([^)\s]+)\)/;
const DELIVERY_IN_MARKER = /Delivery: (request|reply (\S+?))\./;

function parseMarker(reply: AnnotationReply, index: number): Marker | null {
  if (roleOf(reply.author) !== "system") return null;
  const state = reply.body.startsWith(MARKER) ? "sent" : reply.body.startsWith(SENDING_MARKER) ? "sending" : null;
  if (!state) return null;
  const delivery = DELIVERY_IN_MARKER.exec(reply.body);
  const delivered = delivery ? (delivery[1] === "request" ? "request" : (delivery[2] ?? null)) : null;
  return { state, delivered, threadId: THREAD_IN_MARKER.exec(reply.body)?.[1] ?? null, index };
}

/** The index in `replies` through which `marker` says everything is delivered. A marker with no delivery (an old format) covers the replies before it. */
function deliveredIndex(replies: AnnotationReply[], marker: Marker): number {
  if (marker.delivered === null) return marker.index;
  if (marker.delivered === "request") return -1;
  const index = replies.findIndex((reply) => reply.id === marker.delivered);
  return index === -1 ? marker.index : index;
}

function humanReplies(replies: AnnotationReply[], after: number, through: number): AnnotationReply[] {
  return replies.slice(after + 1, through + 1).filter((reply) => roleOf(reply.author) === "human");
}

function deliveryText(kind: Delivery["kind"], annotation: Annotation, replies: AnnotationReply[]): string {
  const bodies = replies.map((reply) => reply.body);
  return (kind === "created" ? [annotation.body, ...bodies] : bodies).join("\n\n");
}

function describeDelivery(delivered: string): string {
  return delivered === "request" ? "Delivery: request." : `Delivery: reply ${delivered}.`;
}

export function sendingMarker(title: string, threadId: string | null, delivered: string): string {
  return threadId
    ? `${SENDING_MARKER} thread "${title}" (t3-thread://v1/${threadId}). ${describeDelivery(delivered)}`
    : `${SENDING_MARKER} as a new thread "${title}". ${describeDelivery(delivered)}`;
}

export function sentMarker(title: string, threadId: string, delivered: string, recovered: boolean): string {
  const note = recovered ? " Completed after a dispatcher restart: check that the thread received it." : "";
  return `${MARKER} "${title}" (t3-thread://v1/${threadId}). ${describeDelivery(delivered)}${note}`;
}

/**
 * Where an annotation's requests stand, derived only from its own replies.
 *
 * Every dispatcher marker names the delivery it belongs to. The last `Sent`
 * marker says which replies are delivered: the one it names and everything
 * before it, or only the body for `request`. Human replies after that point
 * are pending, whatever agent replies or later markers surround them. A
 * `Sending` marker with no `Sent` after it is a delivery in flight.
 *
 * With no marker at all, an open request is new and its text is the body plus
 * any human replies so far. A resolved one without a marker was handled some
 * other way and is left alone.
 */
export function deliveryState(annotation: Annotation): DeliveryState {
  const idle: DeliveryState = { kind: "idle" };
  if (annotation.intent !== "agent-request") return idle;
  const replies = annotation.replies ?? [];
  const markers = replies.map(parseMarker).filter((marker): marker is Marker => marker !== null);
  const lastSent = markers.findLast((marker) => marker.state === "sent") ?? null;
  const sending = markers.findLast((marker) => marker.state === "sending" && marker.index > (lastSent?.index ?? -1)) ?? null;
  if (!lastSent && !sending && annotation.status !== "open") return idle;
  const kind = lastSent ? "replied" : "created";
  const from = lastSent ? deliveredIndex(replies, lastSent) : -1;
  if (sending) {
    const text = deliveryText(kind, annotation, humanReplies(replies, from, deliveredIndex(replies, sending)));
    return { kind: "in-flight", delivery: { kind, text, delivered: sending.delivered ?? "request" }, threadId: sending.threadId };
  }
  const fresh = humanReplies(replies, from, replies.length - 1);
  if (fresh.length === 0 && kind === "replied") return idle;
  return { kind: "pending", delivery: { kind, text: deliveryText(kind, annotation, fresh), delivered: fresh.at(-1)?.id ?? "request" } };
}

/** The next request no thread has received, or null when nothing is pending or a delivery is in flight. */
export function pendingRequest(annotation: Annotation): Delivery | null {
  const state = deliveryState(annotation);
  return state.kind === "pending" ? state.delivery : null;
}

export type RequestFacts = { kind: Delivery["kind"]; path: string; title: string; annotationId: string; text: string };

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
/** What this process knows about a delivery it wrote a `Sending` marker for. `accepted` holds the thread id once T3 took the turn. */
type Attempt = { delivered: string; accepted: string | null };
/**
 * Whether T3 has the turn: `unsent` means this process knows it does not,
 * `accepted` that it does, and `unknown` that a `Sending` marker from an
 * earlier process stands for it, so T3 is not asked twice.
 */
type Handoff = { kind: "unsent"; threadId: string | null } | { kind: "accepted" | "unknown"; threadId: string };

const MAX_RETRY_MS = 5 * 60_000;

const keyOf = (target: Target): Key => `${target.path}\u0000${target.annotationId}`;

/**
 * One loop: subscribe to the docs change stream, scan the corpus on every
 * (re)connect because the stream has no replay, and hand each pending request
 * to its page's T3 thread. All durable state lives in the annotation store.
 */
export class Dispatcher {
  private readonly queue = new Map<Key, Target>();
  /** Consecutive failures per annotation, so a persistent error backs off instead of retrying every few seconds. */
  private readonly failures = new Map<Key, number>();
  /** The one retry timer per failed annotation. While it exists, new events for that annotation wait for it. */
  private readonly retries = new Map<Key, ReturnType<typeof setTimeout>>();
  /** Deliveries this process has written a `Sending` marker for and not completed. */
  private readonly attempts = new Map<Key, Attempt>();
  private draining = false;
  private signal: AbortSignal = new AbortController().signal;
  private readonly retryMs: number;
  private readonly reconnectMs: number;

  constructor(private readonly deps: DispatcherDeps) {
    this.retryMs = deps.retryMs ?? 5_000;
    this.reconnectMs = deps.reconnectMs ?? 2_000;
  }

  /** Runs until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    this.signal = signal;
    try {
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
    } finally {
      for (const timer of this.retries.values()) clearTimeout(timer);
      this.retries.clear();
      this.queue.clear();
    }
  }

  /** Enqueues every annotation with work, across the whole project. */
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

  /** Enqueues the page's annotations with a pending or in-flight delivery and returns how many there were. */
  private async checkPage(path: string): Promise<number> {
    const annotations = await this.deps.docs.annotations(path);
    let found = 0;
    for (const annotation of annotations) {
      if (deliveryState(annotation).kind === "idle") continue;
      found += 1;
      this.enqueue({ path, annotationId: annotation.id });
    }
    return found;
  }

  /** Queues an attempt, unless the annotation is in backoff: then its scheduled attempt reads the new state. */
  private enqueue(target: Target): void {
    if (this.signal.aborted) return;
    const key = keyOf(target);
    if (this.retries.has(key)) {
      this.deps.log(`${target.path} ${target.annotationId} changed, waiting for its retry`);
      return;
    }
    this.queue.set(key, target);
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.queue.size > 0 && !this.signal.aborted) {
        const first = this.queue.entries().next();
        if (first.done) break;
        const [key, target] = first.value;
        this.queue.delete(key);
        try {
          await this.dispatch(target);
          this.failures.delete(key);
        } catch (error) {
          if (this.signal.aborted) return;
          // Any event that arrived during this attempt is covered by the retry.
          this.queue.delete(key);
          const failures = (this.failures.get(key) ?? 0) + 1;
          this.failures.set(key, failures);
          const delay = Math.min(this.retryMs * 2 ** (failures - 1), MAX_RETRY_MS);
          this.deps.log(`dispatch ${target.path} ${target.annotationId} failed (${failures}x), retry in ${delay}ms: ${message(error)}`);
          this.retries.set(
            key,
            setTimeout(() => {
              this.retries.delete(key);
              this.enqueue(target);
            }, delay),
          );
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Reads the annotation fresh and moves its delivery one step: completes a
   * delivery in flight, or records and sends the next pending one.
   *
   * Write order: the `Sending` marker goes down before the T3 call. The marker
   * is the only durable place for the delivery's identity, and a record that
   * exists before the send is what lets a restart decide "already handed to
   * T3" without a second turn. The cost is the reverse window: a crash after
   * the marker and before T3 answers completes on restart as handed off, with
   * a note on the `Sent` marker, so the Lab shows which turn to check.
   */
  private async dispatch(target: Target): Promise<void> {
    const { docs } = this.deps;
    const annotations = await docs.annotations(target.path);
    const annotation = annotations.find((item) => item.id === target.annotationId);
    if (!annotation) return;
    const state = deliveryState(annotation);
    switch (state.kind) {
      case "idle":
        return;
      case "in-flight":
        return this.complete({ target, annotations, annotation, delivery: state.delivery, threadId: state.threadId });
      case "pending": {
        const title = await docs.pageTitle(target.path);
        const existing = await this.liveThread(annotations, title);
        await docs.reply(target.path, target.annotationId, sendingMarker(title, existing, state.delivery.delivered), SYSTEM_AUTHOR, DISPATCHER_ACTOR);
        this.attempts.set(keyOf(target), { delivered: state.delivery.delivered, accepted: null });
        return this.deliver({ target, annotation, title, delivery: state.delivery, handoff: { kind: "unsent", threadId: existing } });
      }
      default: {
        const _exhaustive: never = state;
        return _exhaustive;
      }
    }
  }

  /** Finishes a delivery whose `Sending` marker is on the annotation: the T3 call only when this process knows it never landed, then the Docs writes. */
  private async complete(step: { target: Target; annotations: Annotation[]; annotation: Annotation; delivery: Delivery; threadId: string | null }): Promise<void> {
    const { target, annotations, annotation, delivery, threadId } = step;
    const attempt = this.attempts.get(keyOf(target));
    const own = attempt?.delivered === delivery.delivered ? attempt : null;
    const title = await this.deps.docs.pageTitle(target.path);
    const finish = (handoff: Handoff) => this.deliver({ target, annotation, title, delivery, handoff });
    if (own?.accepted) return finish({ kind: "accepted", threadId: own.accepted });
    if (threadId && !own) {
      // An earlier process wrote the marker and may have sent the turn. The record stands.
      return finish({ kind: "unknown", threadId });
    }
    const live = await this.liveThread(annotations, title);
    if (!threadId && live) {
      // The marker promised a new thread and one exists now: the start landed before the interruption.
      return finish({ kind: "unknown", threadId: live });
    }
    return finish({ kind: "unsent", threadId: live });
  }

  /** The T3 call when the turn is not there yet, then the thread bind and the `Sent` marker. */
  private async deliver(step: { target: Target; annotation: Annotation; title: string; delivery: Delivery; handoff: Handoff }): Promise<void> {
    const { target, annotation, title, delivery, handoff } = step;
    const { docs, t3, t3Project, log } = this.deps;
    const key = keyOf(target);
    const facts: RequestFacts = { kind: delivery.kind, path: target.path, title, annotationId: target.annotationId, text: delivery.text };
    let threadId: string;
    if (handoff.kind !== "unsent") {
      threadId = handoff.threadId;
    } else if (handoff.threadId) {
      threadId = handoff.threadId;
      await t3.send(threadId, threadMessage(facts));
      log(`sent ${delivery.kind} ${target.path} ${target.annotationId} -> thread ${threadId}`);
    } else {
      threadId = await t3.start(t3Project, title, threadMessage(facts));
      log(`started thread ${threadId} "${title}" for ${target.path} ${target.annotationId}`);
    }
    this.attempts.set(key, { delivered: delivery.delivered, accepted: threadId });
    if (annotation.thread?.id !== threadId) await docs.setThread(target.path, target.annotationId, { id: threadId, title }, DISPATCHER_ACTOR);
    const recovered = handoff.kind === "unknown";
    await docs.reply(target.path, target.annotationId, sentMarker(title, threadId, delivery.delivered, recovered), SYSTEM_AUTHOR, DISPATCHER_ACTOR);
    if (recovered) log(`completed ${target.path} ${target.annotationId} -> thread ${threadId} after a restart`);
    this.attempts.delete(key);
  }

  /**
   * The page's thread id: the newest `thread` field among its annotations when
   * `t3 thread show` confirms it, else a project thread titled after the page.
   */
  private async liveThread(annotations: Annotation[], title: string): Promise<string | null> {
    const newest = annotations
      .filter((item) => item.thread)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.thread;
    if (newest) {
      if ((await this.deps.t3.show(newest.id)) === "alive") return newest.id;
      this.deps.log(`thread ${newest.id} is gone`);
    }
    const listed = (await this.deps.t3.list(this.deps.t3Project)).find((thread) => thread.title === title);
    return listed?.threadId ?? null;
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
