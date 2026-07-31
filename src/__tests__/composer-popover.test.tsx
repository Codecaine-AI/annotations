import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import type { AnnotationPanelIntentOption } from "../react/index";
import { AnnotationComposerPopover, DEFAULT_SKIP_SELECTOR } from "../react/index";

afterEach(() => {
  cleanup();
});

const TWO_INTENTS: AnnotationPanelIntentOption[] = [
  { value: "note", label: "Note", hint: "Just a note." },
  { value: "agent-request", label: "Agent request", hint: "Ask an agent." },
];

const popover = () => document.querySelector("[data-annotation-composer]");
const intentButtons = () =>
  document.querySelectorAll("[data-annotation-composer-intent]");

/** Positioned container + anchor paragraph + the popover anchored to it. */
function Host(
  props: Partial<Parameters<typeof AnnotationComposerPopover>[0]> & {
    anchored?: boolean;
  },
) {
  const { anchored = true, ...popoverProps } = props;
  const anchorRef = useRef<HTMLParagraphElement | null>(null);
  const [, forceRender] = useState(0);

  return (
    <div className="relative" style={{ position: "relative" }}>
      <p
        ref={(node) => {
          if (node && !anchorRef.current) {
            anchorRef.current = node;
            forceRender((n) => n + 1); // re-render once the anchor exists
          }
        }}
      >
        Anchor paragraph
      </p>
      <AnnotationComposerPopover
        anchorElements={anchored && anchorRef.current ? [anchorRef.current] : null}
        targetLabel="Block p1"
        onSubmit={async () => {}}
        onCancel={() => {}}
        {...popoverProps}
      />
    </div>
  );
}

const domRect = (top: number, left: number, bottom: number, right: number): DOMRect =>
  ({
    top,
    left,
    bottom,
    right,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

/**
 * Host with mocked geometry: 400x600 container at (0,0), anchor at the given
 * vertical band. happy-dom reports zero rects, so both container and anchor
 * get explicit getBoundingClientRect mocks before the popover measures.
 */
function GeoHost({
  anchorTop,
  anchorBottom,
  ...popoverProps
}: Partial<Parameters<typeof AnnotationComposerPopover>[0]> & {
  anchorTop: number;
  anchorBottom: number;
}) {
  const anchorRef = useRef<HTMLParagraphElement | null>(null);
  const [, forceRender] = useState(0);

  return (
    <div
      style={{ position: "relative" }}
      ref={(node) => {
        if (!node) return;
        node.getBoundingClientRect = () => domRect(0, 0, 600, 400);
        Object.defineProperty(node, "clientWidth", { value: 400, configurable: true });
        Object.defineProperty(node, "clientHeight", { value: 600, configurable: true });
        Object.defineProperty(node, "scrollHeight", { value: 600, configurable: true });
      }}
    >
      <p
        ref={(node) => {
          if (node && !anchorRef.current) {
            node.getBoundingClientRect = () => domRect(anchorTop, 20, anchorBottom, 200);
            anchorRef.current = node;
            forceRender((n) => n + 1);
          }
        }}
      >
        Anchor paragraph
      </p>
      <AnnotationComposerPopover
        anchorElements={anchorRef.current ? [anchorRef.current] : null}
        targetLabel="Block p1"
        onSubmit={async () => {}}
        onCancel={() => {}}
        {...popoverProps}
      />
    </div>
  );
}

describe("AnnotationComposerPopover", () => {
  it("renders header label + textarea and no intent picker for the default single intent", () => {
    render(<Host />);

    expect(popover()).toBeTruthy();
    expect(screen.getByText("Block p1")).toBeTruthy();
    expect(popover()?.querySelector("textarea")).toBeTruthy();
    expect(intentButtons().length).toBe(0);
    expect(screen.getByText("Annotate")).toBeTruthy();
    // Targeting must skip the popover — it must sit inside the skip selector.
    expect(popover()?.getAttribute("data-annotation-ui")).toBe("composer-popover");
  });

  it("renders nothing without anchor elements", () => {
    render(<Host anchored={false} />);
    expect(popover()).toBeFalsy();
  });

  it("shows the intent picker when two intent options are supplied", () => {
    render(<Host intentOptions={TWO_INTENTS} />);
    expect(intentButtons().length).toBe(2);
    expect(screen.getByText("Note")).toBeTruthy();
    expect(screen.getByText("Agent request")).toBeTruthy();
  });

  it("submits the trimmed body with the current intent via the Annotate button", async () => {
    let received: { body: string; intent: string } | null = null;
    render(
      <Host
        intentOptions={TWO_INTENTS}
        onSubmit={async (input) => {
          received = input;
        }}
      />,
    );

    fireEvent.click(screen.getByText("Agent request"));
    const textarea = popover()!.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "  Tighten this section.  " } });
    fireEvent.click(screen.getByText("Annotate"));

    await waitFor(() => {
      expect(received).toEqual({ body: "Tighten this section.", intent: "agent-request" });
    });
    // Successful submit clears the draft.
    expect(textarea.value).toBe("");
  });

  it("submits on Cmd/Ctrl+Enter", async () => {
    let received: { body: string; intent: string } | null = null;
    render(
      <Host
        onSubmit={async (input) => {
          received = input;
        }}
      />,
    );

    const textarea = popover()!.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Fix the intro" } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    await waitFor(() => {
      expect(received).toEqual({ body: "Fix the intro", intent: "agent-request" });
    });
  });

  it("fires onCancel from the header X button", () => {
    let cancelled = false;
    render(
      <Host
        onCancel={() => {
          cancelled = true;
        }}
      />,
    );
    fireEvent.click(screen.getByLabelText("Cancel"));
    expect(cancelled).toBe(true);
  });

  it("injects the self-contained stylesheet alongside the popover", () => {
    render(<Host />);
    const style = document.querySelector('style[data-annotation-ui="style"]');
    expect(style).toBeTruthy();
    expect(style?.textContent).toContain("[data-annotation-composer]");
    expect(style?.textContent).toContain("background: var(--_annotation-surface)");
    expect(style?.textContent).toContain("width: 360px");
    expect(style?.textContent).toContain("max-width: 90%");
  });

  it("positions below the anchor union rect (top = bottom + 8, anchor-left)", async () => {
    render(<GeoHost anchorTop={100} anchorBottom={120} />);

    await waitFor(() => {
      const node = popover() as HTMLElement;
      expect(node.getAttribute("data-annotation-composer-placement")).toBe("below");
      expect(node.style.top).toBe("128px"); // anchor bottom 120 + gap 8
      expect(node.style.left).toBe("20px"); // anchor left, no clamping needed
    });
  });

  it("flips above the anchor when below overflows the container and there is room above", async () => {
    render(<GeoHost anchorTop={580} anchorBottom={595} />);

    await waitFor(() => {
      const node = popover() as HTMLElement;
      expect(node.getAttribute("data-annotation-composer-placement")).toBe("above");
      // top = anchor top 580 - gap 8 - popover height (0 in happy-dom)
      expect(parseFloat(node.style.top)).toBeLessThan(580);
    });
  });

  it("renders a scope breadcrumb for 2+ scopes with the active segment marked", () => {
    render(
      <Host
        scopes={[
          { key: "item-3", label: "List item" },
          { key: "list-1", label: "Bullet list" },
          { key: "sec-2", label: "Section" },
        ]}
        activeScopeKey="item-3"
      />,
    );

    const segments = document.querySelectorAll("[data-annotation-scope]");
    expect(segments.length).toBe(3);
    expect(document.querySelector('[data-annotation-scope="item-3"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector('[data-annotation-scope="list-1"]')?.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Bullet list")).toBeTruthy();
    // Breadcrumb replaces the plain label.
    expect(document.querySelector("[data-annotation-composer-label]")).toBeFalsy();
    expect(document.querySelector("[data-annotation-scopes]")).toBeTruthy();
  });

  it("breadcrumb segments are real buttons whose clicks never reach a host capture-phase pin handler", () => {
    // Regression: hosts pin targets in a capture-phase click handler that
    // skip-lists DEFAULT_SKIP_SELECTOR (prompt-kit's lab). A breadcrumb
    // click must fire onScopeChange and be invisible to that handler — the
    // popover root carries `data-annotation-ui`, which the skip selector
    // matches.
    let pins = 0;
    let changed: string | null = null;
    render(
      <div
        onClickCapture={(event) => {
          const raw = event.target;
          if (raw instanceof HTMLElement && raw.closest(DEFAULT_SKIP_SELECTOR)) return;
          pins += 1;
        }}
      >
        <Host
          scopes={[
            { key: "item-3", label: "List item" },
            { key: "list-1", label: "Bullet list" },
          ]}
          activeScopeKey="item-3"
          onScopeChange={(key) => {
            changed = key;
          }}
        />
      </div>,
    );

    const segment = document.querySelector<HTMLElement>(
      '[data-annotation-scope="list-1"]',
    );
    expect(segment).toBeTruthy();
    expect(segment!.tagName).toBe("BUTTON");
    expect(segment!.getAttribute("type")).toBe("button");

    fireEvent.click(segment!);
    expect(changed as string | null).toBe("list-1");
    expect(pins).toBe(0);
  });

  it("reports scope clicks via onScopeChange without re-anchoring itself", () => {
    let changed: string | null = null;
    render(
      <Host
        scopes={[
          { key: "item-3", label: "List item" },
          { key: "list-1", label: "Bullet list" },
        ]}
        activeScopeKey="item-3"
        onScopeChange={(key) => {
          changed = key;
        }}
      />,
    );

    fireEvent.click(screen.getByText("Bullet list"));
    expect(changed as string | null).toBe("list-1");
  });

  it("falls back to the plain targetLabel for absent or single-entry scopes", () => {
    const { unmount } = render(
      <Host scopes={[{ key: "item-3", label: "List item" }]} activeScopeKey="item-3" />,
    );
    expect(document.querySelector("[data-annotation-scopes]")).toBeFalsy();
    expect(document.querySelector("[data-annotation-composer-label]")?.textContent).toBe("Block p1");
    unmount();

    render(<Host />);
    expect(document.querySelector("[data-annotation-scopes]")).toBeFalsy();
    expect(document.querySelector("[data-annotation-composer-label]")?.textContent).toBe("Block p1");
  });

  it("surfaces submit errors instead of clearing the draft", async () => {
    render(
      <Host
        onSubmit={async () => {
          throw new Error("backend down");
        }}
      />,
    );

    const textarea = popover()!.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Fix it" } });
    fireEvent.click(screen.getByText("Annotate"));

    await waitFor(() => {
      expect(screen.getByText("backend down")).toBeTruthy();
    });
    expect(textarea.value).toBe("Fix it");
  });
});
