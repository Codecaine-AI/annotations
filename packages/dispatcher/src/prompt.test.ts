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
import { Dispatcher, MARKER } from "./dispatcher";
import { PromptSource } from "./prompt";
import { T3 } from "./t3";

const PROJECT = "/repo/prompt-kit";
const MODEL = { provider: "claudeAgent", model: "claude-opus-5-5" };
const PROMPT = "prompts/release-notes.prompt.json";
const TITLE = "Release Notes";
const OTHER = "prompts/changelog.prompt.json";
const OTHER_TITLE = "Changelog";

let fake: FakePromptService;
let t3: ReturnType<typeof useFakeT3>;
let logPath: string;
let stop: () => Promise<void>;

/** The dispatcher's completion markers on an annotation. */
const sentMarkers = (id: string) => fake.annotation(id).replies?.filter((reply) => reply.author === "system" && reply.body.startsWith(MARKER)) ?? [];

async function startDispatcher(): Promise<() => Promise<void>> {
  const controller = new AbortController();
  const dispatcher = new Dispatcher({
    sources: [new PromptSource(fake.stateFile, fake.root, PROJECT)],
    t3: new T3("t3", MODEL),
    // The same append-only file the real logger writes.
    log: (line) => appendFileSync(logPath, `${line}\n`),
    reconnectMs: 50,
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
