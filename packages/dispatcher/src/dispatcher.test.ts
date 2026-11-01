import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The repo root preloads happy-dom for the React tests. This package speaks
// HTTP and SSE, so it needs Bun's own fetch and streams back.
if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();

import { FakeDocs } from "../test/fake-docs-server";
import { Dispatcher } from "./dispatcher";
import { DocsClient } from "./docs";
import { T3 } from "./t3";

const PROJECT = "/repo/knowledge-base";
const MODEL = { provider: "claudeAgent", model: "claude-opus-5-5" };
const PAGE = "sessions/demo/10-spec";
const TITLE = "Demo Spec";
const SETUP_PAGE = "guides/setup";
const SETUP_TITLE = "Setup Guide";

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
const systemReplies = (annotationId: string) => fake.annotation(annotationId).replies?.filter((reply) => reply.author === "system") ?? [];

async function startDispatcher(): Promise<() => Promise<void>> {
  const controller = new AbortController();
  const dispatcher = new Dispatcher({
    docs: new DocsClient(async () => ({ url: fake.url })),
    t3: new T3("t3", MODEL),
    t3Project: PROJECT,
    log: () => {},
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
  fake = new FakeDocs({ [PAGE]: TITLE, [SETUP_PAGE]: SETUP_TITLE });
  stop = await startDispatcher();
});

afterAll(async () => {
  await stop();
  fake.stop();
});

test("a request on a page with no thread starts one, binds it, and tells the Lab", async () => {
  const { id } = await fake.file(PAGE, "Rewrite the intro", "ford");
  await fake.whenever(() => systemReplies(id).length === 1);

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
  expect(systemReplies(id)[0]?.body).toContain(threadId);
});

test("a second request after the first resolves reuses the page's thread", async () => {
  const first = fake.annotations(PAGE)[0];
  const threadId = first?.thread?.id ?? "";
  await fake.resolve(PAGE, first?.id ?? "");

  const { id } = await fake.file(PAGE, "Now tighten the summary", "ford");
  await fake.whenever(() => systemReplies(id).length === 1);

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
  await fake.whenever(() => systemReplies(id).length === 2);

  const sends = callsOf("send");
  expect(sends).toHaveLength(2);
  expect(sends[1]?.stdin).toContain("Also shorten the first paragraph.");
  expect(sends[1]?.stdin).not.toContain("Tightened.");
});

test("when the page's thread is gone, the next request starts a fresh one", async () => {
  const oldThreadId = fake.annotations(PAGE)[0]?.thread?.id ?? "";
  writeFileSync(join(state, "gone.json"), JSON.stringify([oldThreadId]));

  const { id } = await fake.file(PAGE, "Add a glossary", "ford");
  await fake.whenever(() => systemReplies(id).length === 1);

  const newThreadId = fake.annotation(id).thread?.id;
  expect(newThreadId).toMatch(/^[0-9a-f-]{36}$/);
  expect(newThreadId).not.toBe(oldThreadId);
  expect(callsOf("start")).toHaveLength(2);
  expect(callsOf("send").filter((call) => call.args[2] === oldThreadId)).toHaveLength(2);
});

test("a request written outside the API is dispatched when the page's file changes", async () => {
  const written = fake.seed(PAGE, { body: "Link the glossary from the intro", intent: "agent-request", author: "ford" });
  fake.touch(PAGE);
  await fake.whenever(() => systemReplies(written.id).length === 1);

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
  await fake.whenever(() => systemReplies(pending.id).length === 1);

  expect(fake.annotation(pending.id).thread).toEqual({ id: handMade.threadId, title: SETUP_TITLE });
  const send = callsOf("send").at(-1);
  expect(send?.args[2]).toBe(handMade.threadId);
  expect(send?.stdin).toContain("Document the install");
  expect(callsOf("start")).toHaveLength(2);
  expect(fake.annotation(resolved.id).thread).toBeUndefined();
  expect(fake.annotation(resolved.id).replies).toEqual([]);
  expect(fake.annotation(note.id).thread).toBeUndefined();
});
