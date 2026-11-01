import { DISPATCHER_ACTOR, type Annotation, type AnnotationReply, type RequestFacts, type Source } from "./source";
import type { T3 } from "./t3";

/** Completion marker: the turn is in the thread and the annotation records which replies it carried. */
export const MARKER = "Sent to T3 thread";
/** In-flight marker, written before the T3 call, so a crash between the two leaves a record with the delivery's identity. */
export const SENDING_MARKER = "Sending to T3";

export type Role = "human" | "agent" | "system";

/** The annotation convention on every surface: `agent` and `system` are machine authors, everything else is a person. */
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
 * other way and is left alone. Canvas `applied` counts as handled too.
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

export type DispatcherDeps = {
  sources: Source[];
  t3: T3;
  log: (line: string) => void;
  /** Delay before a failed request is tried again. */
  retryMs?: number;
  /** Delay before the first reconnect when a stream drops. Doubles while the source stays down. */
  reconnectMs?: number;
};

type Key = string;
type Target = { source: Source; target: string; annotationId: string };
/** What this process knows about a delivery it wrote a `Sending` marker for. `accepted` holds the thread id once T3 took the turn. */
type Attempt = { delivered: string; accepted: string | null };
/**
 * Whether T3 has the turn: `unsent` means this process knows it does not,
 * `accepted` that it does, and `unknown` that a `Sending` marker from an
 * earlier process stands for it, so T3 is not asked twice.
 */
type Handoff = { kind: "unsent"; threadId: string | null } | { kind: "accepted" | "unknown"; threadId: string };

const MAX_RETRY_MS = 5 * 60_000;
const MAX_RECONNECT_MS = 60_000;

const keyOf = (item: Target): Key => `${item.source.surface}\u0000${item.target}\u0000${item.annotationId}`;

/**
 * One loop: subscribe to every source's change stream, scan a source on every
 * (re)connect because no stream replays, and hand each pending request to its
 * target's T3 thread through one queue. All durable state lives in the
 * annotation stores.
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
      await Promise.all(this.deps.sources.map((source) => this.follow(source, signal)));
    } finally {
      for (const timer of this.retries.values()) clearTimeout(timer);
      this.retries.clear();
      this.queue.clear();
    }
  }

  /** Keeps one source's stream open, reconnecting with backoff while it is down. */
  private async follow(source: Source, signal: AbortSignal): Promise<void> {
    const log = (line: string) => this.deps.log(`[${source.surface}] ${line}`);
    let downs = 0;
    while (!signal.aborted) {
      try {
        for await (const event of source.events(signal)) {
          if (event.kind === "open") {
            downs = 0;
            log("stream open");
            void this.scan(source).catch((error) => log(`scan failed: ${message(error)}`));
            continue;
          }
          if (event.kind === "touched") {
            void this.checkTarget(source, event.target).catch((error) => log(`check ${event.target} failed: ${message(error)}`));
            continue;
          }
          if (event.actor === DISPATCHER_ACTOR) continue;
          if (event.intent !== "agent-request") continue;
          if (event.change !== "created" && event.change !== "replied") continue;
          log(`event ${event.change} ${event.target} ${event.annotationId}${event.actor ? ` by ${event.actor}` : ""}`);
          this.enqueue({ source, target: event.target, annotationId: event.annotationId });
        }
        if (!signal.aborted) log("stream closed");
      } catch (error) {
        if (!signal.aborted) log(`stream error: ${message(error)}`);
      }
      downs += 1;
      if (!signal.aborted) await sleep(Math.min(this.reconnectMs * 2 ** (downs - 1), MAX_RECONNECT_MS), signal);
    }
  }

  /** Enqueues every annotation with work, across the source's targets. */
  async scan(source: Source): Promise<void> {
    const targets = await source.targets();
    let found = 0;
    const pool = 8;
    for (let index = 0; index < targets.length; index += pool) {
      // One unreadable target must not hide the targets after it.
      const counts = await Promise.all(
        targets.slice(index, index + pool).map((target) =>
          this.checkTarget(source, target).catch((error) => {
            this.deps.log(`[${source.surface}] scan ${target} failed: ${message(error)}`);
            return 0;
          }),
        ),
      );
      found += counts.reduce((sum, count) => sum + count, 0);
    }
    this.deps.log(`[${source.surface}] scan done: ${targets.length} targets, ${found} pending`);
  }

  /** Enqueues the target's annotations with a pending or in-flight delivery and returns how many there were. */
  private async checkTarget(source: Source, target: string): Promise<number> {
    const annotations = await source.annotations(target);
    let found = 0;
    for (const annotation of annotations) {
      if (deliveryState(annotation).kind === "idle") continue;
      found += 1;
      this.enqueue({ source, target, annotationId: annotation.id });
    }
    return found;
  }

  /** Queues an attempt, unless the annotation is in backoff: then its scheduled attempt reads the new state. */
  private enqueue(item: Target): void {
    if (this.signal.aborted) return;
    const key = keyOf(item);
    if (this.retries.has(key)) {
      this.deps.log(`[${item.source.surface}] ${item.target} ${item.annotationId} changed, waiting for its retry`);
      return;
    }
    this.queue.set(key, item);
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.queue.size > 0 && !this.signal.aborted) {
        const first = this.queue.entries().next();
        if (first.done) break;
        const [key, item] = first.value;
        this.queue.delete(key);
        try {
          await this.dispatch(item);
          this.failures.delete(key);
        } catch (error) {
          if (this.signal.aborted) return;
          // Any event that arrived during this attempt is covered by the retry.
          this.queue.delete(key);
          const failures = (this.failures.get(key) ?? 0) + 1;
          this.failures.set(key, failures);
          const delay = Math.min(this.retryMs * 2 ** (failures - 1), MAX_RETRY_MS);
          this.deps.log(`[${item.source.surface}] dispatch ${item.target} ${item.annotationId} failed (${failures}x), retry in ${delay}ms: ${message(error)}`);
          this.retries.set(
            key,
            setTimeout(() => {
              this.retries.delete(key);
              this.enqueue(item);
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
   * a note on the `Sent` marker, so the studio shows which turn to check.
   */
  private async dispatch(item: Target): Promise<void> {
    const { source, target, annotationId } = item;
    const annotations = await source.annotations(target);
    const annotation = annotations.find((entry) => entry.id === annotationId);
    if (!annotation) return;
    const state = deliveryState(annotation);
    switch (state.kind) {
      case "idle":
        return;
      case "in-flight":
        await this.complete({ item, annotations, annotation, delivery: state.delivery, threadId: state.threadId });
        // A reply that landed while the delivery was in flight is pending now, so look again.
        this.enqueue(item);
        return;
      case "pending": {
        const title = await source.title(target);
        const existing = await this.liveThread(source, annotations, title);
        await source.reply(target, annotationId, sendingMarker(title, existing, state.delivery.delivered));
        this.attempts.set(keyOf(item), { delivered: state.delivery.delivered, accepted: null });
        return this.deliver({ item, annotation, title, delivery: state.delivery, handoff: { kind: "unsent", threadId: existing } });
      }
      default: {
        const _exhaustive: never = state;
        return _exhaustive;
      }
    }
  }

  /** Finishes a delivery whose `Sending` marker is on the annotation: the T3 call only when this process knows it never landed, then the studio writes. */
  private async complete(step: { item: Target; annotations: Annotation[]; annotation: Annotation; delivery: Delivery; threadId: string | null }): Promise<void> {
    const { item, annotations, annotation, delivery, threadId } = step;
    const attempt = this.attempts.get(keyOf(item));
    const own = attempt?.delivered === delivery.delivered ? attempt : null;
    const title = await item.source.title(item.target);
    const finish = (handoff: Handoff) => this.deliver({ item, annotation, title, delivery, handoff });
    if (own?.accepted) return finish({ kind: "accepted", threadId: own.accepted });
    if (threadId && !own) {
      // An earlier process wrote the marker and may have sent the turn. The record stands.
      return finish({ kind: "unknown", threadId });
    }
    const live = await this.liveThread(item.source, annotations, title);
    if (!threadId && live && !own) {
      // The marker promised a new thread and one exists now: the start landed before the interruption.
      // With `own`, this process saw its start fail, so a live thread is another request's and gets the turn.
      return finish({ kind: "unknown", threadId: live });
    }
    return finish({ kind: "unsent", threadId: live });
  }

  /** The T3 call when the turn is not there yet, then the thread bind and the `Sent` marker. */
  private async deliver(step: { item: Target; annotation: Annotation; title: string; delivery: Delivery; handoff: Handoff }): Promise<void> {
    const { item, annotation, title, delivery, handoff } = step;
    const { source, target, annotationId } = item;
    const { t3 } = this.deps;
    const log = (line: string) => this.deps.log(`[${source.surface}] ${line}`);
    const key = keyOf(item);
    const facts: RequestFacts = { kind: delivery.kind, target, title, annotationId, text: delivery.text };
    let threadId: string;
    if (handoff.kind !== "unsent") {
      threadId = handoff.threadId;
    } else if (handoff.threadId) {
      threadId = handoff.threadId;
      await t3.send(threadId, source.message(facts));
      log(`sent ${delivery.kind} ${target} ${annotationId} -> thread ${threadId}`);
    } else {
      threadId = await t3.start(source.t3Project, title, source.message(facts));
      log(`started thread ${threadId} "${title}" for ${target} ${annotationId}`);
    }
    this.attempts.set(key, { delivered: delivery.delivered, accepted: threadId });
    if (annotation.thread?.id !== threadId) await source.setThread(target, annotationId, { id: threadId, title });
    const recovered = handoff.kind === "unknown";
    await source.reply(target, annotationId, sentMarker(title, threadId, delivery.delivered, recovered));
    if (recovered) log(`completed ${target} ${annotationId} -> thread ${threadId} after a restart`);
    this.attempts.delete(key);
  }

  /**
   * The target's thread id: the newest `thread` field among its annotations
   * when `t3 thread show` confirms it, else a thread in the source's project
   * titled after the target.
   */
  private async liveThread(source: Source, annotations: Annotation[], title: string): Promise<string | null> {
    const newest = annotations
      .filter((item) => item.thread)
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0]?.thread;
    if (newest) {
      if ((await this.deps.t3.show(newest.id)) === "alive") return newest.id;
      this.deps.log(`[${source.surface}] thread ${newest.id} is gone`);
    }
    const listed = (await this.deps.t3.list(source.t3Project)).find((thread) => thread.title === title);
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
