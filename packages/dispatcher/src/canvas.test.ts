import { afterAll, beforeAll, expect, test } from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The repo root preloads happy-dom for the React tests. This package speaks
// HTTP and SSE, so it needs Bun's own fetch and streams back.
if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();

import { FakeCanvasStudio } from "../test/fake-canvas-studio";
import { flag, useFakeT3 } from "../test/fake-t3";
import { Logbook } from "../test/logbook";
import { CanvasSource } from "./canvas";
import { Dispatcher, MARKER } from "./dispatcher";
import { T3 } from "./t3";

const PROJECT = "/repo/canvas";
const MODEL = { provider: "claudeAgent", model: "claude-opus-5-5" };
const BOARD = "payments-flow";
const TITLE = "Payments Flow";
const OTHER = "auth-flow";
const OTHER_TITLE = "Auth Flow";
const BROKEN = "retry-flow";
const BROKEN_TITLE = "Retry Flow";

let fake: FakeCanvasStudio;
let t3: ReturnType<typeof useFakeT3>;
let stop: () => Promise<void>;
let book: Logbook;

/** The dispatcher's completion markers on an annotation. */
const sentMarkers = (id: string) => fake.annotation(id).replies.filter((reply) => reply.author === "system" && reply.body.startsWith(MARKER));

async function startDispatcher(options: { retryMs?: number } = {}): Promise<() => Promise<void>> {
  const controller = new AbortController();
  book = new Logbook();
  const dispatcher = new Dispatcher({ sources: [new CanvasSource(fake.url, PROJECT)], t3: new T3("t3", MODEL), log: book.log, retryMs: options.retryMs });
  const subscribed = fake.subscribed();
  const finished = dispatcher.run(controller.signal);
  await subscribed;
  return () => {
    controller.abort();
    return finished;
  };
}

beforeAll(async () => {
  t3 = useFakeT3();
  fake = new FakeCanvasStudio({ [BOARD]: TITLE, [OTHER]: OTHER_TITLE, [BROKEN]: BROKEN_TITLE });
  stop = await startDispatcher();
});

afterAll(async () => {
  await stop();
  fake.stop();
});

test("a board request starts a thread in the canvas project, binds it, and posts the system reply on the board", async () => {
  const { id } = await fake.file(BOARD, "Group the retry boxes");
  await fake.whenever(() => sentMarkers(id).length === 1);

  const start = t3.callsOf("start")[0];
  expect(start?.args.slice(0, 4)).toEqual(["thread", "start", PROJECT, "-"]);
  expect(flag(start, "--title")).toBe(`${TITLE} · canvas`);
  expect(flag(start, "--provider")).toBe(MODEL.provider);
  expect(flag(start, "--model")).toBe(MODEL.model);
  for (const fact of ["Load the canvas skill", id, BOARD, `${fake.dir}/${BOARD}.canvas.json`, "Group the retry boxes", "annotate", "resolve_request"]) {
    expect(start?.stdin).toContain(fact);
  }

  const annotation = fake.annotation(id);
  const threadId = annotation.thread?.id ?? "";
  expect(threadId).toMatch(/^[0-9a-f-]{36}$/);
  expect(annotation.thread).toEqual({ id: threadId, title: `${TITLE} · canvas` });
  expect(annotation.status).toBe("open");
  expect(sentMarkers(id)[0]?.body).toContain(`t3-thread://v1/${threadId}`);
});

test("a second request on the board reuses its thread, even when a Studio save lands between read and write", async () => {
  const first = fake.boards.get(BOARD)?.annotations[0];
  await fake.resolve(BOARD, first?.id ?? "");
  fake.conflictNext(BOARD);

  const { id } = await fake.file(BOARD, "Label the webhook edge");
  await fake.whenever(() => sentMarkers(id).length === 1);

  expect(fake.conflictsServed).toBe(1);
  expect(fake.annotation(id).thread?.id).toBe(first?.thread?.id);
  expect(t3.callsOf("start")).toHaveLength(1);
  const send = t3.callsOf("send").at(-1);
  expect(send?.args[2]).toBe(first?.thread?.id);
  expect(send?.stdin).toContain("Label the webhook edge");
});

test("a human reply on the board reaches the thread and an agent reply does not", async () => {
  const id = fake.boards.get(BOARD)?.annotations[1]?.id ?? "";
  await fake.reply(BOARD, id, "Labelled it.", "agent");
  await fake.reply(BOARD, id, "Make the label shorter.", "human");
  await fake.whenever(() => sentMarkers(id).length === 2);

  const sends = t3.callsOf("send");
  expect(sends).toHaveLength(2);
  expect(sends[1]?.stdin).toContain("Make the label shorter.");
  expect(sends[1]?.stdin).not.toContain("Labelled it.");
});

test("on start it dispatches a board request filed while it was down and leaves notes and resolved requests alone", async () => {
  await stop();
  const pending = fake.seed(OTHER, { body: "Add the refresh token path" });
  const resolved = fake.seed(OTHER, { body: "Old request", status: "resolved" });
  const note = fake.seed(OTHER, { body: "Just a note", intent: "note" });

  stop = await startDispatcher();
  await fake.whenever(() => sentMarkers(pending.id).length === 1);

  const start = t3.callsOf("start").at(-1);
  expect(t3.callsOf("start")).toHaveLength(2);
  expect(flag(start, "--title")).toBe(`${OTHER_TITLE} · canvas`);
  expect(start?.stdin).toContain("Add the refresh token path");
  expect(fake.annotation(pending.id).thread?.title).toBe(`${OTHER_TITLE} · canvas`);
  expect(fake.annotation(resolved.id).thread).toBeUndefined();
  expect(fake.annotation(note.id).thread).toBeUndefined();
});

test("a human reply saved on the board while a dispatch is in flight is delivered next, and an agent reply alone dispatches nothing", async () => {
  // The first turn is with T3 and its "Sent" marker save is about to land. A
  // Studio save with a human follow-up and an agent answer lands first, so the
  // marker save meets 412 and is redone after them.
  fake.beforeReply = (annotation, body) => {
    if (!body.startsWith(MARKER)) return;
    fake.beforeReply = null;
    fake.inject(BOARD, annotation.id, "Also add a legend.", "human");
    fake.inject(BOARD, annotation.id, "On it.", "agent");
  };
  const { id } = await fake.file(BOARD, "Colour the failure path");
  await fake.whenever(() => sentMarkers(id).length === 2);

  const turns = t3.turnsFor(id);
  expect(turns).toHaveLength(2);
  expect(turns[0]?.stdin).toContain("Colour the failure path");
  expect(turns[1]?.stdin).toContain("Also add a legend.");
  expect(turns[1]?.stdin).not.toContain("On it.");

  await fake.reply(BOARD, id, "Done.", "agent");
  await fake.reply(BOARD, id, "One more: bold the title.", "human");
  await fake.whenever(() => sentMarkers(id).length === 3);
  expect(t3.turnsFor(id)).toHaveLength(3);
  expect(t3.turnsFor(id)[2]?.stdin).toContain("One more: bold the title.");
  expect(t3.turnsFor(id)[2]?.stdin).not.toContain("Done.");
});

test("a board write failure after T3 accepted the turn is retried without a second turn, in process and across a restart", async () => {
  await stop();
  stop = await startDispatcher({ retryMs: 50 });

  // In process: the bind fails once after the send. The retry redoes only the board writes.
  fake.failNextBinds(1);
  const first = await fake.file(OTHER, "Add the logout path");
  await fake.whenever(() => sentMarkers(first.id).length === 1);
  expect(fake.rejectedBinds).toBe(1);
  expect(t3.turnsFor(first.id)).toHaveLength(1);
  expect(fake.annotation(first.id).thread?.id).toBe(t3.turnsFor(first.id)[0]?.args[2]);

  // Across a restart: the dispatcher dies between the failed bind and its retry.
  await stop();
  stop = await startDispatcher({ retryMs: 60_000 });
  fake.failNextBinds(1);
  const second = await fake.file(OTHER, "Add the session timeout");
  await fake.whenever(() => fake.rejectedBinds === 2);
  await stop();
  expect(t3.turnsFor(second.id)).toHaveLength(1);
  expect(sentMarkers(second.id)).toHaveLength(0);

  stop = await startDispatcher();
  await fake.whenever(() => sentMarkers(second.id).length === 1);
  expect(t3.turnsFor(second.id)).toHaveLength(1);
  expect(fake.annotation(second.id).thread?.id).toBe(t3.turnsFor(second.id)[0]?.args[2]);
  expect(sentMarkers(second.id)[0]?.body).toContain("restart");
});

test("a failing board request backs off on one timer, and new replies on it wait for that timer", async () => {
  await stop();
  stop = await startDispatcher({ retryMs: 200 });
  fake.refuseReplies(BROKEN);

  const { id } = await fake.file(BROKEN, "Explain the retries");
  await book.whenever(() => book.count(` ${id} failed (1x)`) === 1);

  // Three human replies inside the backoff window reach the dispatcher but start no attempt.
  for (const body of ["Use a table.", "Name the limits.", "Link the code."]) await fake.reply(BROKEN, id, body, "human");
  await book.whenever(() => book.count(` ${id} changed, waiting for its retry`) === 3);
  expect(fake.refusedReplies(BROKEN)).toHaveLength(1);

  // One attempt at the deadline, then one more at the doubled delay: a stray timer would fire sooner.
  await fake.whenever(() => fake.refusedReplies(BROKEN).length === 3);
  const [first = 0, second = 0, third = 0] = fake.refusedReplies(BROKEN);
  expect(second - first).toBeGreaterThanOrEqual(180);
  expect(third - second).toBeGreaterThanOrEqual(360);
  expect(t3.turnsFor(id)).toHaveLength(0);
});
