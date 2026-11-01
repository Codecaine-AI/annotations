import { afterAll, beforeAll, expect, test } from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The repo root preloads happy-dom for the React tests. This package speaks
// HTTP and SSE, so it needs Bun's own fetch and streams back.
if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();

import { FakeCanvasStudio } from "../test/fake-canvas-studio";
import { flag, useFakeT3 } from "../test/fake-t3";
import { CanvasSource } from "./canvas";
import { Dispatcher, MARKER } from "./dispatcher";
import { T3 } from "./t3";

const PROJECT = "/repo/canvas";
const MODEL = { provider: "claudeAgent", model: "claude-opus-5-5" };
const BOARD = "payments-flow";
const TITLE = "Payments Flow";
const OTHER = "auth-flow";
const OTHER_TITLE = "Auth Flow";

let fake: FakeCanvasStudio;
let t3: ReturnType<typeof useFakeT3>;
let stop: () => Promise<void>;

/** The dispatcher's completion markers on an annotation. */
const sentMarkers = (id: string) => fake.annotation(id).replies.filter((reply) => reply.author === "system" && reply.body.startsWith(MARKER));

async function startDispatcher(): Promise<() => Promise<void>> {
  const controller = new AbortController();
  const dispatcher = new Dispatcher({ sources: [new CanvasSource(fake.url, PROJECT)], t3: new T3("t3", MODEL), log: () => {} });
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
  fake = new FakeCanvasStudio({ [BOARD]: TITLE, [OTHER]: OTHER_TITLE });
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
  expect(flag(start, "--title")).toBe(TITLE);
  expect(flag(start, "--provider")).toBe(MODEL.provider);
  expect(flag(start, "--model")).toBe(MODEL.model);
  for (const fact of ["Load the canvas skill", id, BOARD, `${fake.dir}/${BOARD}.canvas.json`, "Group the retry boxes", "reply_annotation", "resolve_request"]) {
    expect(start?.stdin).toContain(fact);
  }

  const annotation = fake.annotation(id);
  const threadId = annotation.thread?.id ?? "";
  expect(threadId).toMatch(/^[0-9a-f-]{36}$/);
  expect(annotation.thread).toEqual({ id: threadId, title: TITLE });
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
  expect(flag(start, "--title")).toBe(OTHER_TITLE);
  expect(start?.stdin).toContain("Add the refresh token path");
  expect(fake.annotation(pending.id).thread?.title).toBe(OTHER_TITLE);
  expect(fake.annotation(resolved.id).thread).toBeUndefined();
  expect(fake.annotation(note.id).thread).toBeUndefined();
});
