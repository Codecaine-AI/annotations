import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Annotation } from "../core/index";
import { AnnotationPanel } from "../react/index";

afterEach(() => {
  cleanup();
});

type TestTarget = { kind: "block"; blockId: string };

const targetKey = (target: TestTarget) => `block:${target.blockId}`;
const targetLabel = (target: TestTarget) => `Block ${target.blockId}`;

function annotation(overrides: Partial<Annotation<TestTarget>> = {}): Annotation<TestTarget> {
  return {
    id: "c1",
    target: { kind: "block", blockId: "p1" },
    body: "Please clarify this.",
    intent: "note",
    author: "ford",
    status: "open",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

const noop = () => {};
const asyncNoop = async () => {};

describe("AnnotationPanel", () => {
  it("renders an empty state when there are no annotations and no selection", () => {
    render(
      <AnnotationPanel<TestTarget>
        annotations={[]}
        selection={null}
        targetKey={targetKey}
        targetLabel={targetLabel}
        onClearSelection={noop}
        onAddAnnotation={asyncNoop}
        onResolveAnnotation={asyncNoop}
      />,
    );
    expect(screen.getByText(/No annotations yet/)).toBeTruthy();
  });

  it("groups annotations by target with open counts and target data attributes", () => {
    render(
      <AnnotationPanel<TestTarget>
        annotations={[
          annotation(),
          annotation({ id: "c2", status: "resolved", body: "Looks good now." }),
        ]}
        selection={null}
        targetKey={targetKey}
        targetLabel={targetLabel}
        onClearSelection={noop}
        onAddAnnotation={asyncNoop}
        onResolveAnnotation={asyncNoop}
      />,
    );
    expect(screen.getByText("1 open")).toBeTruthy();
    expect(screen.getByText("Please clarify this.")).toBeTruthy();
    expect(screen.getByText("Looks good now.")).toBeTruthy();
    expect(screen.getByText("Resolved")).toBeTruthy();
    expect(document.querySelector('[data-plannotator-target="block:p1"]')).toBeTruthy();
  });

  it("submits the composer with the toggled intent, then clears the selection", async () => {
    let received: { target: unknown; body: string; intent: string } | null = null;
    let cleared = false;

    render(
      <AnnotationPanel<TestTarget>
        annotations={[]}
        selection={{ target: { kind: "block", blockId: "p1" }, label: "Intro paragraph" }}
        targetKey={targetKey}
        targetLabel={targetLabel}
        onClearSelection={() => {
          cleared = true;
        }}
        onAddAnnotation={async (input) => {
          received = input;
        }}
        onResolveAnnotation={asyncNoop}
      />,
    );

    expect(screen.getByText(/Annotating: Intro paragraph/)).toBeTruthy();

    const agentToggle = screen.getByText("Agent request");
    expect(agentToggle.closest("button")?.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(agentToggle);
    expect(agentToggle.closest("button")?.getAttribute("aria-pressed")).toBe("true");

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "  Please refactor this block.  " } });
    fireEvent.click(screen.getByText("Post annotation"));

    await waitFor(() => {
      expect(received).toEqual({
        target: { kind: "block", blockId: "p1" },
        body: "Please refactor this block.",
        intent: "agent-request",
      });
    });
    expect(cleared).toBe(true);
  });

  it("calls onResolveAnnotation when Resolve is clicked on an open annotation", async () => {
    let resolvedId: string | null = null;
    render(
      <AnnotationPanel<TestTarget>
        annotations={[annotation()]}
        selection={null}
        targetKey={targetKey}
        targetLabel={targetLabel}
        onClearSelection={noop}
        onAddAnnotation={asyncNoop}
        onResolveAnnotation={async (id) => {
          resolvedId = id;
        }}
      />,
    );
    fireEvent.click(screen.getByText("Resolve"));
    await waitFor(() => {
      expect(resolvedId).toBe("c1");
    });
  });

  it("hides the composer and shows custom empty state with showComposer={false}", () => {
    render(
      <AnnotationPanel<TestTarget>
        annotations={[]}
        selection={{ target: { kind: "block", blockId: "p1" }, label: "Intro paragraph" }}
        targetKey={targetKey}
        targetLabel={targetLabel}
        showComposer={false}
        emptyState="No annotations yet. Click a block to annotate it in place."
        onClearSelection={noop}
        onAddAnnotation={asyncNoop}
        onResolveAnnotation={asyncNoop}
      />,
    );

    expect(document.querySelector('[data-plannotator="composer"]')).toBeFalsy();
    expect(screen.queryByText(/Annotating:/)).toBeFalsy();
    expect(document.querySelector("textarea")).toBeFalsy();
    expect(screen.getByText(/Click a block to annotate it in place/)).toBeTruthy();
    expect(screen.queryByText(/Select a block or canvas object/)).toBeFalsy();
  });

  it("hides the intent picker row for a single intent option and submits with it", async () => {
    let received: { body: string; intent: string } | null = null;
    render(
      <AnnotationPanel<TestTarget>
        annotations={[]}
        selection={{ target: { kind: "block", blockId: "p1" } }}
        targetKey={targetKey}
        targetLabel={targetLabel}
        intentOptions={[
          { value: "agent-request", label: "Agent request", hint: "Ask an agent." },
        ]}
        onClearSelection={noop}
        onAddAnnotation={async (input) => {
          received = { body: input.body, intent: input.intent };
        }}
        onResolveAnnotation={asyncNoop}
      />,
    );

    expect(document.querySelector("[data-plannotator-intent]")).toBeFalsy();

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Do the thing" } });
    fireEvent.click(screen.getByText("Post annotation"));

    await waitFor(() => {
      expect(received).toEqual({ body: "Do the thing", intent: "agent-request" });
    });
  });

  it("renders an annotation's replies as a read-only thread without onAddReply", () => {
    render(
      <AnnotationPanel<TestTarget>
        annotations={[
          annotation({
            replies: [
              {
                id: "r1",
                author: "agent",
                body: "Done — tightened the section.",
                createdAt: "2026-07-02T00:00:00.000Z",
              },
              {
                id: "r2",
                author: "ford",
                body: "Looks right, thanks.",
                createdAt: "2026-07-02T01:00:00.000Z",
              },
            ],
          }),
        ]}
        selection={null}
        targetKey={targetKey}
        targetLabel={targetLabel}
        onClearSelection={noop}
        onAddAnnotation={asyncNoop}
        onResolveAnnotation={asyncNoop}
      />,
    );

    expect(document.querySelector("[data-plannotator-replies]")).toBeTruthy();
    expect(document.querySelector('[data-annotation-reply-id="r1"]')).toBeTruthy();
    expect(document.querySelector('[data-annotation-reply-id="r2"]')).toBeTruthy();
    expect(screen.getByText("Done — tightened the section.")).toBeTruthy();
    expect(screen.getByText("Looks right, thanks.")).toBeTruthy();
    // Read-only: no reply affordance without onAddReply.
    expect(document.querySelector("[data-plannotator-reply-open]")).toBeFalsy();
  });

  it("shows the Reply affordance only for open annotations when onAddReply is provided", () => {
    render(
      <AnnotationPanel<TestTarget>
        annotations={[
          annotation(),
          annotation({ id: "c2", status: "resolved", body: "Old one." }),
        ]}
        selection={null}
        targetKey={targetKey}
        targetLabel={targetLabel}
        onClearSelection={noop}
        onAddAnnotation={asyncNoop}
        onResolveAnnotation={asyncNoop}
        onAddReply={async () => {}}
      />,
    );

    const openButtons = document.querySelectorAll("[data-plannotator-reply-open]");
    expect(openButtons.length).toBe(1);
    expect(
      openButtons[0].closest("[data-plannotator-annotation-id]")?.getAttribute("data-plannotator-annotation-id"),
    ).toBe("c1");
  });

  it("submits a trimmed reply body to onAddReply and clears the inline composer", async () => {
    let received: { annotationId: string; body: string } | null = null;
    render(
      <AnnotationPanel<TestTarget>
        annotations={[annotation()]}
        selection={null}
        targetKey={targetKey}
        targetLabel={targetLabel}
        onClearSelection={noop}
        onAddAnnotation={asyncNoop}
        onResolveAnnotation={asyncNoop}
        onAddReply={async (annotationId, body) => {
          received = { annotationId, body };
        }}
      />,
    );

    fireEvent.click(document.querySelector("[data-plannotator-reply-open]")!);
    const composer = document.querySelector("[data-plannotator-reply-composer]")!;
    const textarea = composer.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "  Also fix the heading.  " } });
    fireEvent.click(document.querySelector("[data-plannotator-reply-submit]")!);

    await waitFor(() => {
      expect(received).toEqual({ annotationId: "c1", body: "Also fix the heading." });
    });
    // Cleared and closed on success.
    expect(document.querySelector("[data-plannotator-reply-composer]")).toBeFalsy();
    expect(document.querySelector("[data-plannotator-reply-open]")).toBeTruthy();
  });

  it("submits a reply on Cmd/Ctrl+Enter", async () => {
    let received: { annotationId: string; body: string } | null = null;
    render(
      <AnnotationPanel<TestTarget>
        annotations={[annotation()]}
        selection={null}
        targetKey={targetKey}
        targetLabel={targetLabel}
        onClearSelection={noop}
        onAddAnnotation={asyncNoop}
        onResolveAnnotation={asyncNoop}
        onAddReply={async (annotationId, body) => {
          received = { annotationId, body };
        }}
      />,
    );

    fireEvent.click(document.querySelector("[data-plannotator-reply-open]")!);
    const textarea = document
      .querySelector("[data-plannotator-reply-composer]")!
      .querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Ship it" } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    await waitFor(() => {
      expect(received).toEqual({ annotationId: "c1", body: "Ship it" });
    });
  });

  it("surfaces reply submit errors inline and keeps the draft", async () => {
    render(
      <AnnotationPanel<TestTarget>
        annotations={[annotation()]}
        selection={null}
        targetKey={targetKey}
        targetLabel={targetLabel}
        onClearSelection={noop}
        onAddAnnotation={asyncNoop}
        onResolveAnnotation={asyncNoop}
        onAddReply={async () => {
          throw new Error("reply backend down");
        }}
      />,
    );

    fireEvent.click(document.querySelector("[data-plannotator-reply-open]")!);
    const textarea = document
      .querySelector("[data-plannotator-reply-composer]")!
      .querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Try this" } });
    fireEvent.click(document.querySelector("[data-plannotator-reply-submit]")!);

    await waitFor(() => {
      expect(screen.getByText("reply backend down")).toBeTruthy();
    });
    expect(document.querySelector("[data-plannotator-reply-error]")).toBeTruthy();
    expect(textarea.value).toBe("Try this");
  });

  it("renders a target-removed badge and reason for annotations listed in danglingReasons", () => {
    render(
      <AnnotationPanel<TestTarget>
        annotations={[annotation()]}
        selection={null}
        targetKey={targetKey}
        targetLabel={targetLabel}
        danglingReasons={new Map([["c1", 'Block "p1" no longer exists.']])}
        onClearSelection={noop}
        onAddAnnotation={asyncNoop}
        onResolveAnnotation={asyncNoop}
      />,
    );
    expect(screen.getByText("Target removed")).toBeTruthy();
    expect(screen.getByText(/no longer exists/)).toBeTruthy();
    expect(document.querySelector("[data-plannotator-dangling-reason]")).toBeTruthy();
  });
});
