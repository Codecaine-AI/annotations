import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The repo root preloads happy-dom for the React tests. This package speaks
// HTTP and SSE, so it needs Bun's own fetch and streams back.
if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();

import { FakePromptService } from "../test/fake-prompt-service";
import { flag, useFakeT3 } from "../test/fake-t3";
import { Logbook } from "../test/logbook";
import { Dispatcher, MARKER } from "./dispatcher";
import { PromptSource } from "./prompt";
import { T3 } from "./t3";

const PROJECT = "/repo/prompt-kit";
const MODEL = { provider: "claudeAgent", model: "claude-opus-5-5" };
const PROMPT = "prompts/release-notes.prompt.json";
const TITLE = "Release Notes";
const OTHER = "prompts/changelog.prompt.json";
const OTHER_TITLE = "Changelog";
const BROKEN = "prompts/retries.prompt.json";
const BROKEN_TITLE = "Retries";

let fake: FakePromptService;
let t3: ReturnType<typeof useFakeT3>;
let logPath: string;
let stop: () => Promise<void>;
let book: Logbook;

/** The dispatcher's completion markers on an annotation. */
const sentMarkers = (id: string) => fake.annotation(id).replies?.filter((reply) => reply.author === "system" && reply.body.startsWith(MARKER)) ?? [];

async function startDispatcher(options: { retryMs?: number } = {}): Promise<() => Promise<void>> {
  const controller = new AbortController();
  book = new Logbook();
  const dispatcher = new Dispatcher({
    sources: [new PromptSource(fake.stateFile, fake.root, PROJECT)],
    t3: new T3("t3", MODEL),
    // The same append-only file the real logger writes.
    log: (line) => {
      appendFileSync(logPath, `${line}\n`);
      book.log(line);
    },
    reconnectMs: 50,
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
  t3 = useFakeT3();
  const dir = mkdtempSync(join(tmpdir(), "dispatcher-prompt-"));
  logPath = join(dir, "dispatcher.log");
  writeFileSync(logPath, "");
  fake = new FakePromptService("/repo/prompt-kit", join(dir, "daemon.json"), [
    { id: "release-notes", title: TITLE, path: PROMPT },
    { id: "changelog", title: OTHER_TITLE, path: OTHER },
    { id: "retries", title: BROKEN_TITLE, path: BROKEN },
  ]);
  stop = await startDispatcher();
});

afterAll(async () => {
  await stop();
  fake.stop();
});

test("a prompt request starts a thread in the prompt-kit project, binds it, and posts the system reply", async () => {
  const { id } = await fake.file(PROMPT, "Make the tone warmer");
  await fake.whenever(() => sentMarkers(id).length === 1);

  const start = t3.callsOf("start")[0];
  expect(start?.args.slice(0, 4)).toEqual(["thread", "start", PROJECT, "-"]);
  expect(flag(start, "--title")).toBe(TITLE);
  for (const fact of ["Load the prompt-kit skill", id, PROMPT, fake.root, "Make the tone warmer", "prompts_request_reply", "prompts_request_resolve"]) {
    expect(start?.stdin).toContain(fact);
  }

  const annotation = fake.annotation(id);
  const threadId = annotation.thread?.id ?? "";
  expect(threadId).toMatch(/^[0-9a-f-]{36}$/);
  expect(annotation.thread).toEqual({ id: threadId, title: TITLE });
  expect(annotation.status).toBe("open");
  expect(sentMarkers(id)[0]?.body).toContain(`t3-thread://v1/${threadId}`);
});

test("a second request on the prompt reuses its thread", async () => {
  const first = fake.prompts.get(PROMPT)?.annotations[0];
  await fake.resolve(PROMPT, first?.id ?? "");

  const { id } = await fake.file(PROMPT, "Drop the emoji");
  await fake.whenever(() => sentMarkers(id).length === 1);

  expect(fake.annotation(id).thread?.id).toBe(first?.thread?.id);
  expect(t3.callsOf("start")).toHaveLength(1);
  const send = t3.callsOf("send").at(-1);
  expect(send?.args[2]).toBe(first?.thread?.id);
  expect(send?.stdin).toContain("Drop the emoji");
});

test("a human reply on the prompt reaches the thread and an agent reply does not", async () => {
  const id = fake.prompts.get(PROMPT)?.annotations[1]?.id ?? "";
  await fake.reply(PROMPT, id, "Removed them.", "agent");
  await fake.reply(PROMPT, id, "Keep the rocket one.", "ford");
  await fake.whenever(() => sentMarkers(id).length === 2);

  const sends = t3.callsOf("send");
  expect(sends).toHaveLength(2);
  expect(sends[1]?.stdin).toContain("Keep the rocket one.");
  expect(sends[1]?.stdin).not.toContain("Removed them.");
});

test("after a service restart with a new token, it dispatches the request filed while it was down", async () => {
  await stop();
  const pending = fake.seed(OTHER, { body: "List breaking changes first" });
  const note = fake.seed(OTHER, { body: "Just a note", intent: "note" });
  fake.restart();

  stop = await startDispatcher();
  await fake.whenever(() => sentMarkers(pending.id).length === 1);

  const start = t3.callsOf("start").at(-1);
  expect(flag(start, "--title")).toBe(OTHER_TITLE);
  expect(start?.stdin).toContain("List breaking changes first");
  expect(fake.annotation(note.id).thread).toBeUndefined();
});

test("a stream dropped by a restart reconnects with the new token, and no token ever reaches the log", async () => {
  fake.restart();
  await fake.subscribed();
  const { id } = await fake.file(OTHER, "Date every entry");
  await fake.whenever(() => sentMarkers(id).length === 1);

  const log = readFileSync(logPath, "utf8");
  expect(log).toContain("stream open");
  expect(log).toContain("started thread");
  expect(fake.tokens).toHaveLength(3);
  for (const token of fake.tokens) expect(log).not.toContain(token);
});

test("a human reply on the prompt that lands while a dispatch is in flight is delivered next, and an agent reply alone dispatches nothing", async () => {
  // The first turn is with T3 and its "Sent" marker is about to land. In that
  // window a human follows up and the agent answers, both before the marker.
  fake.beforeReply = (annotation, body) => {
    if (!body.startsWith(MARKER)) return;
    fake.beforeReply = null;
    fake.inject(PROMPT, annotation.id, "Also mention the date.", "ford");
    fake.inject(PROMPT, annotation.id, "On it.", "agent");
  };
  const { id } = await fake.file(PROMPT, "Shorten the intro");
  await fake.whenever(() => sentMarkers(id).length === 2);

  const turns = t3.turnsFor(id);
  expect(turns).toHaveLength(2);
  expect(turns[0]?.stdin).toContain("Shorten the intro");
  expect(turns[1]?.stdin).toContain("Also mention the date.");
  expect(turns[1]?.stdin).not.toContain("On it.");

  await fake.reply(PROMPT, id, "Done.", "agent");
  await fake.reply(PROMPT, id, "One more: sign it off.", "ford");
  await fake.whenever(() => sentMarkers(id).length === 3);
  expect(t3.turnsFor(id)).toHaveLength(3);
  expect(t3.turnsFor(id)[2]?.stdin).toContain("One more: sign it off.");
  expect(t3.turnsFor(id)[2]?.stdin).not.toContain("Done.");
});

test("a prompt write failure after T3 accepted the turn is retried without a second turn, in process and across a restart", async () => {
  await stop();
  stop = await startDispatcher({ retryMs: 50 });

  // In process: the bind fails once after the send. The retry redoes only the prompt writes.
  fake.failNextBinds(1);
  const first = await fake.file(OTHER, "Group by component");
  await fake.whenever(() => sentMarkers(first.id).length === 1);
  expect(fake.rejectedBinds).toBe(1);
  expect(t3.turnsFor(first.id)).toHaveLength(1);
  expect(fake.annotation(first.id).thread?.id).toBe(t3.turnsFor(first.id)[0]?.args[2]);

  // Across a restart: the dispatcher dies between the failed bind and its retry.
  await stop();
  stop = await startDispatcher({ retryMs: 60_000 });
  fake.failNextBinds(1);
  const second = await fake.file(OTHER, "Link each pull request");
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

test("a failing prompt request backs off on one timer, and new replies on it wait for that timer", async () => {
  await stop();
  stop = await startDispatcher({ retryMs: 200 });
  fake.refuseReplies(BROKEN);

  const { id } = await fake.file(BROKEN, "Explain the retries");
  await book.whenever(() => book.count(` ${id} failed (1x)`) === 1);

  // Three human replies inside the backoff window reach the dispatcher but start no attempt.
  for (const body of ["Use a table.", "Name the limits.", "Link the code."]) await fake.reply(BROKEN, id, body, "ford");
  await book.whenever(() => book.count(` ${id} changed, waiting for its retry`) === 3);
  expect(fake.refusedReplies(BROKEN)).toHaveLength(1);

  // One attempt at the deadline, then one more at the doubled delay: a stray timer would fire sooner.
  await fake.whenever(() => fake.refusedReplies(BROKEN).length === 3);
  const [first = 0, second = 0, third = 0] = fake.refusedReplies(BROKEN);
  expect(second - first).toBeGreaterThanOrEqual(180);
  expect(third - second).toBeGreaterThanOrEqual(360);
  expect(t3.turnsFor(id)).toHaveLength(0);
});
