import { afterAll, beforeAll, expect, test } from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The repo root preloads happy-dom for the React tests. This package speaks
// HTTP and SSE, so it needs Bun's own fetch and streams back.
if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();

import { FakeCanvasStudio } from "../test/fake-canvas-studio";
import { FakeDocs } from "../test/fake-docs-server";
import { flag, useFakeT3 } from "../test/fake-t3";
import { CanvasSource } from "./canvas";
import { Dispatcher, MARKER } from "./dispatcher";
import { DocsSource } from "./docs";
import { T3 } from "./t3";

// A docs page and a canvas board with the same title, both owned by one T3 project.
const PROJECT = "/repo/canvas";
const MODEL = { provider: "claudeAgent", model: "claude-opus-5-5" };
const TITLE = "Payments Flow";
const PAGE = "docs/payments-flow";
const BOARD = "payments-flow";

let docs: FakeDocs;
let canvas: FakeCanvasStudio;
let t3: ReturnType<typeof useFakeT3>;
let controller: AbortController;
let finished: Promise<void>;

const isSent = (reply: { author: string; body: string }) => reply.author === "system" && reply.body.startsWith(MARKER);
const pageSent = (id: string) => docs.annotation(id).replies?.filter(isSent).length ?? 0;
const boardSent = (id: string) => canvas.annotation(id).replies.filter(isSent).length;

beforeAll(async () => {
  t3 = useFakeT3();
  docs = new FakeDocs({ [PAGE]: TITLE });
  canvas = new FakeCanvasStudio({ [BOARD]: TITLE });
  controller = new AbortController();
  const dispatcher = new Dispatcher({
    sources: [new DocsSource(async () => ({ url: docs.url }), PROJECT), new CanvasSource(canvas.url, PROJECT)],
    t3: new T3("t3", MODEL),
    log: () => {},
  });
  const subscribed = Promise.all([docs.subscribed(), canvas.subscribed()]);
  finished = dispatcher.run(controller.signal);
  await subscribed;
});

afterAll(async () => {
  controller.abort();
  await finished;
  docs.stop();
  canvas.stop();
});

test("a page and a board with the same title in one T3 project each get their own thread and reuse it", async () => {
  const page = await docs.file(PAGE, "Rewrite the intro", "ford");
  await docs.whenever(() => pageSent(page.id) === 1);
  const board = await canvas.file(BOARD, "Group the retry boxes");
  await canvas.whenever(() => boardSent(board.id) === 1);

  const starts = t3.callsOf("start");
  expect(starts.map((start) => flag(start, "--title"))).toEqual([`${TITLE} · docs`, `${TITLE} · canvas`]);
  const pageThread = docs.annotation(page.id).thread?.id ?? "";
  const boardThread = canvas.annotation(board.id).thread?.id ?? "";
  expect(pageThread).toMatch(/^[0-9a-f-]{36}$/);
  expect(boardThread).toMatch(/^[0-9a-f-]{36}$/);
  expect(boardThread).not.toBe(pageThread);

  const pageAgain = await docs.file(PAGE, "Link the glossary", "ford");
  await docs.whenever(() => pageSent(pageAgain.id) === 1);
  const boardAgain = await canvas.file(BOARD, "Color the failure path");
  await canvas.whenever(() => boardSent(boardAgain.id) === 1);

  expect(t3.callsOf("start")).toHaveLength(2);
  expect(t3.turnsFor(pageAgain.id).map((call) => call.args.slice(1, 3))).toEqual([["send", pageThread]]);
  expect(t3.turnsFor(boardAgain.id).map((call) => call.args.slice(1, 3))).toEqual([["send", boardThread]]);
});
