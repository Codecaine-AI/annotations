import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ResolvedTarget } from "../react/index";
import { TARGETING_CSS, TargetingLayer } from "../react/index";

afterEach(() => {
  cleanup();
});

type TestTarget = { kind: "block"; blockId: string };

function resolveTarget(element: HTMLElement): ResolvedTarget<TestTarget> | null {
  const hit = element.closest("[data-testblock]");
  if (!(hit instanceof HTMLElement)) return null;
  const blockId = hit.dataset.testblock ?? "";
  return {
    elements: [hit],
    target: { kind: "block", blockId },
    label: `Block ${blockId}`,
  };
}

function Surface(
  props: Partial<Parameters<typeof TargetingLayer<TestTarget>>[0]> = {},
) {
  return (
    <TargetingLayer<TestTarget> active resolveTarget={resolveTarget} {...props}>
      <p data-testblock="p1">First paragraph</p>
      <p data-testblock="p2">Second paragraph</p>
      <button type="button">Skip me</button>
    </TargetingLayer>
  );
}

const hoverRing = () => document.querySelector('[data-annotation-ui="hover-ring"]');
const hoverChip = () => document.querySelector('[data-annotation-ui="hover-chip"]');
const selectedRing = () =>
  document.querySelector('[data-annotation-ui="selected-ring"]');

describe("TargetingLayer", () => {
  it("renders ring + chip with the resolved label on hover", () => {
    render(<Surface />);
    fireEvent.mouseMove(screen.getByText("First paragraph"));

    expect(hoverRing()).toBeTruthy();
    expect(hoverChip()).toBeTruthy();
    expect(hoverChip()?.textContent).toBe("Block p1");
    expect(
      document
        .querySelector("[data-annotation-targeting]")
        ?.getAttribute("data-annotation-targeting"),
    ).toBe("true");
  });

  it("glides to the new target label when hover moves to another block", () => {
    render(<Surface />);
    fireEvent.mouseMove(screen.getByText("First paragraph"));
    expect(hoverChip()?.textContent).toBe("Block p1");
    fireEvent.mouseMove(screen.getByText("Second paragraph"));
    expect(hoverChip()?.textContent).toBe("Block p2");
  });

  it("does not target skip elements (built-in skip selector)", () => {
    render(<Surface />);
    fireEvent.mouseMove(screen.getByText("Skip me"));
    expect(hoverRing()).toBeFalsy();
    expect(hoverChip()).toBeFalsy();
  });

  it("re-measures overlays when a DESCENDANT scroller scrolls (capture-phase)", async () => {
    render(
      <TargetingLayer<TestTarget>
        active
        resolveTarget={resolveTarget}
        resolveSelected={() => {
          const element = document.querySelector('[data-testblock="p1"]');
          return element instanceof HTMLElement ? [element] : null;
        }}
        resolveToken="scroll-test"
      >
        <div data-scroller="">
          <p data-testblock="p1">First paragraph</p>
        </div>
      </TargetingLayer>,
    );
    const target = document.querySelector(
      '[data-testblock="p1"]',
    ) as HTMLElement;
    let top = 40;
    target.getBoundingClientRect = () =>
      ({ top, left: 0, right: 100, bottom: top + 10, width: 100, height: 10 }) as DOMRect;
    const scroller = document.querySelector("[data-scroller]")!;
    // Content scrolls inside the container: the element's viewport rect moves.
    // `scroll` does not bubble — only a capture-phase container listener can
    // see a descendant scroller's event.
    scroller.dispatchEvent(new Event("scroll"));
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    const before = (selectedRing() as HTMLElement).style.top;

    top = -160;
    scroller.dispatchEvent(new Event("scroll"));
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));

    const after = (selectedRing() as HTMLElement).style.top;
    expect(after).not.toBe(before);
  });

  it("clears the hover ring on mouseleave", () => {
    render(<Surface />);
    const paragraph = screen.getByText("First paragraph");
    fireEvent.mouseMove(paragraph);
    expect(hoverRing()).toBeTruthy();
    const container = document.querySelector("[data-annotation-targeting]")!;
    fireEvent.mouseLeave(container);
    expect(hoverRing()).toBeFalsy();
  });

  it("fires onTargetSelect with the resolved target on click", () => {
    let received: ResolvedTarget<TestTarget> | null = null;
    render(
      <Surface
        onTargetSelect={(resolved) => {
          received = resolved;
        }}
      />,
    );
    fireEvent.click(screen.getByText("First paragraph"));

    expect(received).not.toBeNull();
    expect(received!.target).toEqual({ kind: "block", blockId: "p1" });
    expect(received!.label).toBe("Block p1");
    expect(received!.elements[0]?.dataset.testblock).toBe("p1");
  });

  it("suppresses clicks landing on skip elements", () => {
    let selected = 0;
    render(
      <Surface
        onTargetSelect={() => {
          selected += 1;
        }}
      />,
    );
    fireEvent.click(screen.getByText("Skip me"));
    expect(selected).toBe(0);
  });

  it("renders nothing and targets nothing when inactive", () => {
    render(<Surface active={false} />);
    fireEvent.mouseMove(screen.getByText("First paragraph"));

    expect(document.querySelector("[data-annotation-ui]")).toBeFalsy();
    expect(
      document
        .querySelector("[data-annotation-targeting]")
        ?.getAttribute("data-annotation-targeting"),
    ).toBe("false");
  });

  it("shows the selected ring when resolveSelected returns elements", () => {
    render(
      <Surface
        resolveSelected={() => {
          const element = document.querySelector('[data-testblock="p2"]');
          return element instanceof HTMLElement ? [element] : null;
        }}
        resolveToken="selection-1"
      />,
    );
    expect(selectedRing()).toBeTruthy();
  });

  it("hides the selected ring when resolveSelected returns null", () => {
    render(<Surface resolveSelected={() => null} />);
    expect(selectedRing()).toBeFalsy();
  });

  it("renders both rings with dotted borders (the selection affordance)", () => {
    render(
      <Surface
        resolveSelected={() => {
          const element = document.querySelector('[data-testblock="p2"]');
          return element instanceof HTMLElement ? [element] : null;
        }}
      />,
    );
    fireEvent.mouseMove(screen.getByText("First paragraph"));

    const hover = hoverRing() as HTMLElement;
    const selected = selectedRing() as HTMLElement;
    expect(hover.style.borderStyle).toBe("dotted");
    expect(selected.style.borderStyle).toBe("dotted");
    expect(TARGETING_CSS).toContain("border-style: dotted");
  });

  it("gives every ring a dotted border and NO background fill", () => {
    // The dotted border is the whole affordance — a tinted fill washed out
    // the very content being targeted, so no ring paints a background.
    // No ring-only rule paints a tint (the scope chips still use color-mix).
    expect(TARGETING_CSS).not.toMatch(
      /\[data-annotation-ring\]\s*\{[^}]*background:\s*color-mix/,
    );
    // Both ring selectors share one fill-free rule.
    expect(TARGETING_CSS).toContain(
      [
        "[data-annotation-ring],",
        "  [data-annotation-ring-selected] {",
      ].join("\n"),
    );
    expect(TARGETING_CSS).toContain("background: transparent;\n    border: 2px dotted");

    render(
      <Surface
        resolveSelected={() => {
          const element = document.querySelector('[data-testblock="p2"]');
          return element instanceof HTMLElement ? [element] : null;
        }}
      />,
    );
    fireEvent.mouseMove(screen.getByText("First paragraph"));

    for (const ring of [hoverRing(), selectedRing()] as HTMLElement[]) {
      expect(ring).toBeTruthy();
      // No Tailwind fill utility (bg-primary/5 and friends) survives either.
      expect(ring.className).not.toMatch(/\bbg-/);
      expect(ring.style.background).toBe("");
      expect(ring.style.backgroundColor).toBe("");
    }
  });

  it("ships self-contained ring, chip and popover styling in the injected CSS", () => {
    // Ring border must not depend on host Tailwind — full border shorthand
    // with a package-owned var + fallback. No fill: border only.
    expect(TARGETING_CSS).toContain("border: 2px dotted var(--_annotation-accent)");
    expect(TARGETING_CSS).toContain("--_annotation-accent: var(--annotation-accent, #6366f1)");
    // Popover + chip surfaces are solid and opaque from the injected CSS alone.
    expect(TARGETING_CSS).toContain("[data-annotation-composer]");
    expect(TARGETING_CSS).toContain("[data-annotation-chip]");
    expect(TARGETING_CSS).toContain("background: var(--_annotation-surface)");
    expect(TARGETING_CSS).toContain("--_annotation-surface: var(--annotation-surface, #ffffff)");
    expect(TARGETING_CSS).toContain("prefers-color-scheme: dark");
    expect(TARGETING_CSS).toContain("box-shadow");

    render(<Surface />);
    const style = document.querySelector('style[data-annotation-ui="style"]');
    expect(style?.textContent).toContain("2px dotted");
    expect(style?.textContent).toContain("[data-annotation-composer]");
  });

  it("marks overlays with the styling data attributes the injected CSS keys off", () => {
    render(
      <Surface
        resolveSelected={() => {
          const element = document.querySelector('[data-testblock="p2"]');
          return element instanceof HTMLElement ? [element] : null;
        }}
      />,
    );
    fireEvent.mouseMove(screen.getByText("First paragraph"));

    expect((hoverRing() as HTMLElement).hasAttribute("data-annotation-ring")).toBe(true);
    expect((hoverChip() as HTMLElement).hasAttribute("data-annotation-chip")).toBe(true);
    expect(
      (selectedRing() as HTMLElement).hasAttribute("data-annotation-ring-selected"),
    ).toBe(true);
  });

  it("suppressHover hides the hover overlays and skips resolution but keeps the selected ring", () => {
    render(
      <Surface
        suppressHover
        resolveSelected={() => {
          const element = document.querySelector('[data-testblock="p2"]');
          return element instanceof HTMLElement ? [element] : null;
        }}
      />,
    );
    fireEvent.mouseMove(screen.getByText("First paragraph"));

    expect(hoverRing()).toBeFalsy();
    expect(hoverChip()).toBeFalsy();
    expect(selectedRing()).toBeTruthy();
    // Cursor attribute unaffected — targeting still reads active.
    expect(
      document
        .querySelector("[data-annotation-targeting]")
        ?.getAttribute("data-annotation-targeting"),
    ).toBe("true");
  });

  it("clears an existing hover when suppressHover turns on", () => {
    const { rerender } = render(<Surface />);
    fireEvent.mouseMove(screen.getByText("First paragraph"));
    expect(hoverRing()).toBeTruthy();

    rerender(<Surface suppressHover />);
    expect(hoverRing()).toBeFalsy();
    expect(hoverChip()).toBeFalsy();
  });

  it("renders the chip inside the ring's top-left when it would clamp above the container", () => {
    // happy-dom rects are all zero → ringTop - CHIP_LIFT < 0 → inside fallback.
    render(<Surface />);
    fireEvent.mouseMove(screen.getByText("First paragraph"));

    const chip = hoverChip() as HTMLElement;
    expect(chip.getAttribute("data-annotation-chip-placement")).toBe("inside");
    // Inside the ring: below the ring's top edge, not lifted above it.
    expect(parseFloat(chip.style.top)).toBeGreaterThanOrEqual(-3);
  });

  it("floats the chip above the ring when there is room above", () => {
    render(<Surface />);
    const container = document.querySelector("[data-annotation-targeting]") as HTMLElement;
    const block = screen.getByText("First paragraph");
    container.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 400, bottom: 600, width: 400, height: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    block.getBoundingClientRect = () =>
      ({ top: 200, left: 40, right: 360, bottom: 240, width: 320, height: 40, x: 40, y: 200, toJSON: () => ({}) }) as DOMRect;

    fireEvent.mouseMove(block);

    const chip = hoverChip() as HTMLElement;
    expect(chip.getAttribute("data-annotation-chip-placement")).toBe("above");
    expect(chip.style.top).toBe("176px"); // 200 - CHIP_LIFT(24)
  });

  it("completes a modifier-drag released OUTSIDE the container (window-level mouseup)", () => {
    let calls = 0;
    render(
      <Surface
        rangeModifier="meta"
        onRangeSelect={() => {
          calls += 1;
        }}
      />,
    );

    const paragraph = screen.getByText("First paragraph");
    const range = document.createRange();
    range.setStart(paragraph.firstChild as Text, 0);
    range.setEnd(paragraph.firstChild as Text, 5);
    const fakeSelection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => "First",
      removeAllRanges: () => {},
    } as unknown as Selection;

    const originalGetSelection = window.getSelection;
    window.getSelection = () => fakeSelection;
    try {
      // Drag starts inside the container with Cmd held…
      fireEvent.mouseDown(paragraph, { metaKey: true });
      // …but releases on the body, outside the container: the container's
      // React mouseup never fires, the window listener must complete it.
      fireEvent.mouseUp(document.body);
      expect(calls).toBe(1);
      // A release INSIDE the container is not double-emitted by the window
      // listener (the container handler consumes the drag first).
      fireEvent.mouseDown(paragraph, { metaKey: true });
      fireEvent.mouseUp(paragraph);
      expect(calls).toBe(2);
    } finally {
      window.getSelection = originalGetSelection;
    }
  });

  it("clears the native selection after reporting a range (annotate mode shows no text highlight)", () => {
    let cleared = 0;
    render(<Surface onRangeSelect={() => {}} />);

    const paragraph = screen.getByText("First paragraph");
    const range = document.createRange();
    range.setStart(paragraph.firstChild as Text, 0);
    range.setEnd(paragraph.firstChild as Text, 5);
    const fakeSelection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => "First",
      removeAllRanges: () => {
        cleared += 1;
      },
    } as unknown as Selection;

    const originalGetSelection = window.getSelection;
    window.getSelection = () => fakeSelection;
    try {
      fireEvent.mouseUp(paragraph);
    } finally {
      window.getSelection = originalGetSelection;
    }
    expect(cleared).toBe(1);
  });

  it("hides the native selection highlight via injected CSS while targeting is active", () => {
    expect(TARGETING_CSS).toContain('[data-annotation-targeting="true"] ::selection');
    expect(TARGETING_CSS).toContain("background: transparent");
  });

  it("fires onRangeSelect for a non-collapsed selection inside the container", () => {
    let received: { range: Range; text: string } | null = null;
    render(
      <Surface
        onRangeSelect={(selection) => {
          received = selection;
        }}
      />,
    );

    const paragraph = screen.getByText("First paragraph");
    const textNode = paragraph.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);

    const fakeSelection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => "First",
    } as unknown as Selection;

    const originalGetSelection = window.getSelection;
    window.getSelection = () => fakeSelection;
    try {
      fireEvent.mouseUp(paragraph);
    } finally {
      window.getSelection = originalGetSelection;
    }

    expect(received).not.toBeNull();
    expect(received!.text).toBe("First");
    expect(received!.range).toBe(range);
  });

  it('rangeModifier "meta": fires onRangeSelect only when the release carries Cmd/Ctrl', () => {
    let calls = 0;
    render(
      <Surface
        rangeModifier="meta"
        onRangeSelect={() => {
          calls += 1;
        }}
      />,
    );

    const paragraph = screen.getByText("First paragraph");
    const range = document.createRange();
    range.setStart(paragraph.firstChild as Text, 0);
    range.setEnd(paragraph.firstChild as Text, 5);
    const fakeSelection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => "First",
    } as unknown as Selection;

    const originalGetSelection = window.getSelection;
    window.getSelection = () => fakeSelection;
    try {
      // Unmodified release: the selection is ignored entirely.
      fireEvent.mouseUp(paragraph);
      expect(calls).toBe(0);
      // Cmd held on the releasing mouseup fires.
      fireEvent.mouseUp(paragraph, { metaKey: true });
      expect(calls).toBe(1);
      // Ctrl counts as "meta" too (non-mac).
      fireEvent.mouseUp(paragraph, { ctrlKey: true });
      expect(calls).toBe(2);
      // Keyboard selections check the keyup's modifier state the same way.
      fireEvent.keyUp(paragraph, { key: "ArrowRight", shiftKey: true });
      expect(calls).toBe(2);
      fireEvent.keyUp(paragraph, { key: "ArrowRight", shiftKey: true, metaKey: true });
      expect(calls).toBe(3);
    } finally {
      window.getSelection = originalGetSelection;
    }
  });

  it('default rangeModifier ("none") fires without any modifier held', () => {
    let calls = 0;
    render(
      <Surface
        onRangeSelect={() => {
          calls += 1;
        }}
      />,
    );

    const paragraph = screen.getByText("First paragraph");
    const range = document.createRange();
    range.setStart(paragraph.firstChild as Text, 0);
    range.setEnd(paragraph.firstChild as Text, 5);
    const fakeSelection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => "First",
    } as unknown as Selection;

    const originalGetSelection = window.getSelection;
    window.getSelection = () => fakeSelection;
    try {
      fireEvent.mouseUp(paragraph);
    } finally {
      window.getSelection = originalGetSelection;
    }
    expect(calls).toBe(1);
  });

  it("hardens breadcrumb segments in the injected CSS (hit area, cursor, hover, wrap)", () => {
    // ≥24px hit height, pointer cursor and a visible hover state on every
    // segment; the breadcrumb row wraps instead of truncating ancestors.
    expect(TARGETING_CSS).toContain("min-height: 24px");
    expect(TARGETING_CSS).toMatch(
      /\[data-annotation-scope\]\s*\{[^}]*cursor: pointer/,
    );
    expect(TARGETING_CSS).toContain("[data-annotation-scope]:hover");
    expect(TARGETING_CSS).toMatch(
      /\[data-annotation-scopes\]\s*\{[^}]*flex-wrap: wrap/,
    );
    // pointer-events: none must stay confined to the non-interactive
    // overlays (rings + chip) and disabled buttons — never the composer
    // surface, its header or the breadcrumb.
    for (const selector of [
      "[data-annotation-composer] {",
      "[data-annotation-composer-header] {",
      "[data-annotation-scopes] {",
      "[data-annotation-scope] {",
    ]) {
      const start = TARGETING_CSS.indexOf(selector);
      expect(start).toBeGreaterThan(-1);
      const block = TARGETING_CSS.slice(start, TARGETING_CSS.indexOf("}", start));
      expect(block).not.toContain("pointer-events");
    }
  });

  it("fires onRangeSelect when the modifier was held at mousedown but released before mouseup", () => {
    let calls = 0;
    render(
      <Surface
        rangeModifier="meta"
        onRangeSelect={() => {
          calls += 1;
        }}
      />,
    );

    const paragraph = screen.getByText("First paragraph");
    const range = document.createRange();
    range.setStart(paragraph.firstChild as Text, 0);
    range.setEnd(paragraph.firstChild as Text, 5);
    const fakeSelection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => "First",
    } as unknown as Selection;

    const originalGetSelection = window.getSelection;
    window.getSelection = () => fakeSelection;
    try {
      // Cmd at mousedown, released before the mouse: the drag still counts.
      fireEvent.mouseDown(paragraph, { metaKey: true });
      fireEvent.mouseUp(paragraph);
      expect(calls).toBe(1);
      // A drag that never carried the modifier stays ignored.
      fireEvent.mouseDown(paragraph);
      fireEvent.mouseUp(paragraph);
      expect(calls).toBe(1);
    } finally {
      window.getSelection = originalGetSelection;
    }
  });

  it("renders the live drag ring during a modifier-drag, suppressing hover; a plain drag shows neither", () => {
    render(<Surface rangeModifier="meta" onRangeSelect={() => {}} />);

    const container = document.querySelector(
      "[data-annotation-targeting]",
    ) as HTMLElement;
    container.getBoundingClientRect = () =>
      ({ top: 10, left: 20, right: 420, bottom: 610, width: 400, height: 600, x: 20, y: 10, toJSON: () => ({}) }) as DOMRect;

    const paragraph = screen.getByText("First paragraph");
    const range = document.createRange();
    range.setStart(paragraph.firstChild as Text, 0);
    range.setEnd(paragraph.firstChild as Text, 5);
    // happy-dom has no layout — stub the selection rects the ring unions.
    (range as unknown as { getClientRects: () => DOMRect[] }).getClientRects = () => [
      { top: 110, left: 60, right: 260, bottom: 126, width: 200, height: 16 } as DOMRect,
      { top: 126, left: 60, right: 180, bottom: 142, width: 120, height: 16 } as DOMRect,
    ];
    const fakeSelection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => "First",
    } as unknown as Selection;

    const dragRing = () => document.querySelector('[data-annotation-ui="drag-ring"]');
    const originalGetSelection = window.getSelection;
    window.getSelection = () => fakeSelection;
    try {
      // Modifier-drag in progress: dotted ring wraps the live selection...
      fireEvent.mouseDown(paragraph, { metaKey: true });
      fireEvent.mouseMove(paragraph, { metaKey: true });
      const ring = dragRing() as HTMLElement;
      expect(ring).toBeTruthy();
      expect(ring.style.borderStyle).toBe("dotted");
      expect(ring.hasAttribute("data-annotation-ring-selected")).toBe(true);
      // Union of the stubbed rects (container-relative, RING_INSET = 3):
      // top 110-10-3, left 60-20-3, width 200+6, height 32+6.
      expect(ring.style.top).toBe("97px");
      expect(ring.style.left).toBe("37px");
      expect(ring.style.width).toBe("206px");
      expect(ring.style.height).toBe("38px");
      // ...and the hover ring/chip stand down mid-drag.
      expect(hoverRing()).toBeFalsy();
      expect(hoverChip()).toBeFalsy();

      // Release retires the live ring.
      fireEvent.mouseUp(paragraph, { metaKey: true });
      expect(dragRing()).toBeFalsy();

      // A plain (unmodified) drag renders no drag ring, and hover resumes.
      fireEvent.mouseDown(paragraph);
      fireEvent.mouseMove(paragraph);
      expect(dragRing()).toBeFalsy();
      expect(hoverRing()).toBeTruthy();
      fireEvent.mouseUp(paragraph);
    } finally {
      window.getSelection = originalGetSelection;
    }
  });

  it("ignores selections that end outside the container", () => {
    let calls = 0;
    render(
      <Surface
        onRangeSelect={() => {
          calls += 1;
        }}
      />,
    );

    const outside = document.createElement("p");
    outside.textContent = "Outside text";
    document.body.appendChild(outside);

    const paragraph = screen.getByText("First paragraph");
    const range = document.createRange();
    range.setStart(paragraph.firstChild as Text, 0);
    range.setEnd(outside.firstChild as Text, 3);

    const fakeSelection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => "irrelevant",
    } as unknown as Selection;

    const originalGetSelection = window.getSelection;
    window.getSelection = () => fakeSelection;
    try {
      fireEvent.mouseUp(paragraph);
    } finally {
      window.getSelection = originalGetSelection;
      outside.remove();
    }

    expect(calls).toBe(0);
  });
});
