import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The repo root preloads happy-dom for the React tests. This package speaks
// HTTP and SSE, so it needs Bun's own fetch and streams back.
if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();

import { FakeDocs } from "../test/fake-docs-server";
import { Dispatcher, MARKER } from "./dispatcher";
import { DocsClient } from "./docs";
import { T3 } from "./t3";

const PROJECT = "/repo/knowledge-base";
const MODEL = { provider: "claudeAgent", model: "claude-opus-5-5" };
const PAGE = "sessions/demo/10-spec";
const TITLE = "Demo Spec";
const SETUP_PAGE = "guides/setup";
const SETUP_TITLE = "Setup Guide";
const BROKEN_PAGE = "guides/retries";
const BROKEN_TITLE = "Retries Guide";

type Call = { args: string[]; stdin: string };

let fake: FakeDocs;
let state: string;
let stop: () => Promise<void>;

const calls = (): Call[] => {
  const file = join(state, "calls.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Call);
};
const callsOf = (subcommand: string): Call[] => calls().filter((call) => call.args[1] === subcommand);
/** The turns T3 received for one annotation: thread starts and sends whose message names it. */
const turnsFor = (annotationId: string): Call[] =>
  calls().filter((call) => (call.args[1] === "start" || call.args[1] === "send") && call.stdin.includes(`Annotation: ${annotationId}`));
/** The dispatcher's completion markers on an annotation. */
const sentMarkers = (annotationId: string) =>
  fake.annotation(annotationId).replies?.filter((reply) => reply.author === "system" && reply.body.startsWith(MARKER)) ?? [];

async function startDispatcher(options: { retryMs?: number } = {}): Promise<() => Promise<void>> {
  const controller = new AbortController();
  const dispatcher = new Dispatcher({
    docs: new DocsClient(async () => ({ url: fake.url })),
    t3: new T3("t3", MODEL),
    t3Project: PROJECT,
    log: () => {},
    retryMs: options.retryMs,
  });
  const subscribed = fake.subscribed();
  const finished = dispatcher.run(controller.signal);
  await subscribed;
  return () => {
    controller.abort();
    return finished;
  };
}

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), "dispatcher-test-"));
  process.env.T3_FAKE_STATE = state;
  process.env.PATH = `${join(import.meta.dir, "..", "test", "bin")}:${process.env.PATH}`;
  fake = new FakeDocs({ [PAGE]: TITLE, [SETUP_PAGE]: SETUP_TITLE, [BROKEN_PAGE]: BROKEN_TITLE });
  stop = await startDispatcher();
});

afterAll(async () => {
  await stop();
  fake.stop();
});

test("a request on a page with no thread starts one, binds it, and tells the Lab", async () => {
  const { id } = await fake.file(PAGE, "Rewrite the intro", "ford");
  await fake.whenever(() => sentMarkers(id).length === 1);

  const start = callsOf("start")[0];
  expect(start?.args.slice(0, 4)).toEqual(["thread", "start", PROJECT, "-"]);
  expect(start?.args[start.args.indexOf("--title") + 1]).toBe(TITLE);
  expect(start?.args[start.args.indexOf("--provider") + 1]).toBe(MODEL.provider);
  expect(start?.args[start.args.indexOf("--model") + 1]).toBe(MODEL.model);
  for (const fact of ["docs-system", id, PAGE, "Rewrite the intro", "docs_annotation_reply"]) {
    expect(start?.stdin).toContain(fact);
  }

  const annotation = fake.annotation(id);
  const threadId = annotation.thread?.id ?? "";
  expect(threadId).toMatch(/^[0-9a-f-]{36}$/);
  expect(annotation.thread).toEqual({ id: threadId, title: TITLE });
  expect(annotation.status).toBe("open");
  expect(sentMarkers(id)[0]?.body).toContain(threadId);
});

test("a second request after the first resolves reuses the page's thread", async () => {
  const first = fake.annotations(PAGE)[0];
  const threadId = first?.thread?.id ?? "";
  await fake.resolve(PAGE, first?.id ?? "");

  const { id } = await fake.file(PAGE, "Now tighten the summary", "ford");
  await fake.whenever(() => sentMarkers(id).length === 1);

  expect(fake.annotation(id).thread?.id).toBe(threadId);
  expect(callsOf("start")).toHaveLength(1);
  const send = callsOf("send").at(-1);
  expect(send?.args[2]).toBe(threadId);
  for (const fact of [id, PAGE, "Now tighten the summary"]) expect(send?.stdin).toContain(fact);
});

test("a human reply reaches the thread and an agent reply does not", async () => {
  const id = fake.annotations(PAGE)[1]?.id ?? "";
  await fake.reply(PAGE, id, "Tightened. See the new summary.", "agent");
  await fake.reply(PAGE, id, "Also shorten the first paragraph.", "ford");
  await fake.whenever(() => sentMarkers(id).length === 2);

  const sends = callsOf("send");
  expect(sends).toHaveLength(2);
  expect(sends[1]?.stdin).toContain("Also shorten the first paragraph.");
  expect(sends[1]?.stdin).not.toContain("Tightened.");
});

test("when the page's thread is gone, the next request starts a fresh one", async () => {
  const oldThreadId = fake.annotations(PAGE)[0]?.thread?.id ?? "";
  writeFileSync(join(state, "gone.json"), JSON.stringify([oldThreadId]));

  const { id } = await fake.file(PAGE, "Add a glossary", "ford");
  await fake.whenever(() => sentMarkers(id).length === 1);

  const newThreadId = fake.annotation(id).thread?.id;
  expect(newThreadId).toMatch(/^[0-9a-f-]{36}$/);
  expect(newThreadId).not.toBe(oldThreadId);
  expect(callsOf("start")).toHaveLength(2);
  expect(callsOf("send").filter((call) => call.args[2] === oldThreadId)).toHaveLength(2);
});

test("a request written outside the API is dispatched when the page's file changes", async () => {
  const written = fake.seed(PAGE, { body: "Link the glossary from the intro", intent: "agent-request", author: "ford" });
  fake.touch(PAGE);
  await fake.whenever(() => sentMarkers(written.id).length === 1);

  const send = callsOf("send").at(-1);
  expect(send?.args[2]).toBe(fake.annotation(written.id).thread?.id);
  expect(send?.stdin).toContain("Link the glossary from the intro");
});

test("on start it dispatches open requests filed while it was down and reuses a thread titled after the page", async () => {
  await stop();
  const pending = fake.seed(SETUP_PAGE, { body: "Document the install", intent: "agent-request", author: "ford" });
  const resolved = fake.seed(SETUP_PAGE, { body: "Old request", intent: "agent-request", author: "ford", status: "resolved" });
  const note = fake.seed(SETUP_PAGE, { body: "Just a note", intent: "note", author: "ford" });
  const handMade = { threadId: "11111111-2222-4333-8444-555555555555", title: SETUP_TITLE, status: "completed" };
  const threads = JSON.parse(readFileSync(join(state, "threads.json"), "utf8")) as unknown[];
  writeFileSync(join(state, "threads.json"), JSON.stringify([handMade, ...threads]));

  stop = await startDispatcher();
  await fake.whenever(() => sentMarkers(pending.id).length === 1);

  expect(fake.annotation(pending.id).thread).toEqual({ id: handMade.threadId, title: SETUP_TITLE });
  const send = callsOf("send").at(-1);
  expect(send?.args[2]).toBe(handMade.threadId);
  expect(send?.stdin).toContain("Document the install");
  expect(callsOf("start")).toHaveLength(2);
  expect(fake.annotation(resolved.id).thread).toBeUndefined();
  expect(fake.annotation(resolved.id).replies).toEqual([]);
  expect(fake.annotation(note.id).thread).toBeUndefined();
});

test("a human reply that lands while a dispatch is in flight is delivered next, and an agent reply alone dispatches nothing", async () => {
  // The first turn is with T3 and its "Sent" marker is about to land. In that
  // window a human follows up and the agent answers, both before the marker.
  fake.beforeReply = (annotation, body) => {
    if (!body.startsWith(MARKER)) return;
    fake.beforeReply = null;
    fake.inject(PAGE, annotation.id, "Also add a diagram.", "ford");
    fake.inject(PAGE, annotation.id, "On it.", "agent");
  };
  const { id } = await fake.file(PAGE, "Describe the data model", "ford");
  await fake.whenever(() => sentMarkers(id).length === 2);

  const turns = turnsFor(id);
  expect(turns).toHaveLength(2);
  expect(turns[0]?.stdin).toContain("Describe the data model");
  expect(turns[1]?.stdin).toContain("Also add a diagram.");
  expect(turns[1]?.stdin).not.toContain("On it.");

  // Events are handled in order, so a turn for the agent reply would land
  // before the one for the human reply that follows it.
  await fake.reply(PAGE, id, "Done.", "agent");
  await fake.reply(PAGE, id, "One more: add a legend.", "ford");
  await fake.whenever(() => sentMarkers(id).length === 3);
  expect(turnsFor(id)).toHaveLength(3);
  expect(turnsFor(id)[2]?.stdin).toContain("One more: add a legend.");
  expect(turnsFor(id)[2]?.stdin).not.toContain("Done.");
});

test("a Docs failure after T3 accepted the turn is retried without a second turn, in process and across a restart", async () => {
  await stop();
  stop = await startDispatcher({ retryMs: 50 });

  // In process: the bind fails once after the send. The retry redoes only the Docs writes.
  fake.failNextBinds(1);
  const first = await fake.file(SETUP_PAGE, "Add the uninstall steps", "ford");
  await fake.whenever(() => sentMarkers(first.id).length === 1);
  expect(fake.rejectedBinds).toBe(1);
  expect(turnsFor(first.id)).toHaveLength(1);
  expect(fake.annotation(first.id).thread?.id).toBe(turnsFor(first.id)[0]?.args[2]);

  // Across a restart: the dispatcher dies between the failed bind and its retry.
  await stop();
  stop = await startDispatcher({ retryMs: 60_000 });
  fake.failNextBinds(1);
  const second = await fake.file(SETUP_PAGE, "Add the log path", "ford");
  await fake.whenever(() => fake.rejectedBinds === 2);
  await stop();
  expect(turnsFor(second.id)).toHaveLength(1);
  expect(sentMarkers(second.id)).toHaveLength(0);

  stop = await startDispatcher();
  await fake.whenever(() => sentMarkers(second.id).length === 1);
  expect(turnsFor(second.id)).toHaveLength(1);
  expect(fake.annotation(second.id).thread?.id).toBe(turnsFor(second.id)[0]?.args[2]);
  expect(sentMarkers(second.id)[0]?.body).toContain("restart");
});

test("a failing annotation backs off on one timer, and new events for it wait for that timer", async () => {
  await stop();
  stop = await startDispatcher({ retryMs: 200 });
  fake.breakTitle(BROKEN_PAGE);

  const { id } = await fake.file(BROKEN_PAGE, "Explain the retries", "ford");
  await fake.whenever(() => fake.bundleReads(BROKEN_PAGE).length === 1);

  // Three bare page events inside the backoff window are read but not attempted.
  const seen = fake.annotationReads(BROKEN_PAGE);
  fake.touch(BROKEN_PAGE);
  fake.touch(BROKEN_PAGE);
  fake.touch(BROKEN_PAGE);
  await fake.whenever(() => fake.annotationReads(BROKEN_PAGE) >= seen + 3);
  expect(fake.bundleReads(BROKEN_PAGE)).toHaveLength(1);

  // One attempt at the deadline, then one more at the doubled delay: a stray timer would fire sooner.
  await fake.whenever(() => fake.bundleReads(BROKEN_PAGE).length === 2);
  await fake.whenever(() => fake.bundleReads(BROKEN_PAGE).length === 3);
  const [first = 0, second = 0, third = 0] = fake.bundleReads(BROKEN_PAGE);
  expect(second - first).toBeGreaterThanOrEqual(180);
  expect(third - second).toBeGreaterThanOrEqual(360);
  expect(turnsFor(id)).toHaveLength(0);
});
