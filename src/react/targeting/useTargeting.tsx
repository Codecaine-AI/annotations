"use client";

/**
 * Generic hover/click targeting primitives — the Plannotator targeting UX
 * (hover an element -> a highlight ring glides to it with a floating label
 * chip; click -> the host pins the target; drag text -> range selection)
 * extracted from docs-system's DocTargetingLayer, minus every docs specific
 * (block registry, anchors, popovers, marks). Hosts supply `resolveTarget`
 * to map raw DOM elements to their own target type.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

export type ResolvedTarget<TTarget> = {
  /**
   * Element(s) to outline — multiple for row-based surfaces where one logical
   * node spans several row divs; the ring covers the union rect.
   */
  elements: HTMLElement[];
  target: TTarget;
  label: string;
};

export interface TargetingOptions<TTarget> {
  /** Master switch — when false, no listeners, no overlays, zero cost. */
  active: boolean;
  /**
   * Map the hovered element to a resolved target, or null (not targetable).
   * Called with the raw event target element.
   */
  resolveTarget: (element: HTMLElement) => ResolvedTarget<TTarget> | null;
  /** Click on a resolved target. */
  onTargetSelect?: (resolved: ResolvedTarget<TTarget>) => void;
  /**
   * Non-collapsed text selection released inside the container (mouseup /
   * keyup). Host builds a range target from the DOM Range. Optional — omit
   * to ignore drags.
   */
  onRangeSelect?: (selection: { range: Range; text: string }) => void;
  /**
   * Modifier gating `onRangeSelect`. Default `"none"` — every non-collapsed
   * selection fires (the original behavior). `"meta"` accepts either the meta
   * key (Cmd on macOS) or Ctrl, so one setting covers both platforms. A
   * mouse drag counts as modified when the modifier was held at ANY point of
   * the drag — mousedown, any mousemove, or the releasing mouseup — so
   * letting go of Cmd a beat before the mouse does not silently drop the
   * range. Keyboard selections check the releasing keyup. When the drag never
   * carried the modifier the selection is simply ignored — the native browser
   * selection may remain visible, but no range target is reported.
   */
  rangeModifier?: RangeModifier;
  /**
   * Controlled selected ring: resolve the currently-selected target to
   * elements, or null for no ring. Re-resolved on annotations/content
   * changes via `resolveToken`.
   */
  resolveSelected?: () => HTMLElement[] | null;
  /** Change this value to force `resolveSelected` to re-run. */
  resolveToken?: unknown;
  /**
   * Elements to never target (buttons, inputs, ...). Merged with the built-in
   * default (`DEFAULT_SKIP_SELECTOR`).
   */
  skipSelector?: string;
  /**
   * When true, the hover ring + label chip do not render and mousemove
   * resolution is skipped entirely (the `data-annotation-targeting` cursor
   * attribute is unaffected); the selected ring still renders. Hosts set
   * this while their composer popover is open so the hover affordance does
   * not float over it.
   */
  suppressHover?: boolean;
}

/** See `TargetingOptions.rangeModifier`. */
export type RangeModifier = "meta" | "alt" | "shift" | "none";

export interface TargetingContainerProps {
  /** Reflects `active` so hosts can attach cursor CSS. */
  "data-annotation-targeting": "true" | "false";
  onMouseDown: (event: ReactMouseEvent<HTMLElement>) => void;
  onMouseMove: (event: ReactMouseEvent<HTMLElement>) => void;
  onMouseLeave: () => void;
  onClick: (event: ReactMouseEvent<HTMLElement>) => void;
  onMouseUp: (event: ReactMouseEvent<HTMLElement>) => void;
  onKeyUp: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

export interface Targeting<TTarget> {
  containerRef: RefObject<HTMLDivElement | null>;
  /** Delegated mouse/key handlers + the `data-annotation-targeting` attr. */
  containerProps: TargetingContainerProps;
  hoverTarget: ResolvedTarget<TTarget> | null;
  /**
   * Hover ring + label chip + selected ring + `<style>`. Render inside the
   * container; the container must be `position: relative`.
   */
  overlays: ReactNode;
}

/** Elements that are never targetable, merged with any host `skipSelector`. */
export const DEFAULT_SKIP_SELECTOR = [
  "button",
  "textarea",
  "input",
  "select",
  '[contenteditable="true"]',
  "[data-annotation-ui]",
].join(", ");

/**
 * The complete, self-contained stylesheet for the targeting overlays, label
 * chip and composer popover. Injected as a `<style>` tag by both the
 * targeting overlays and `AnnotationComposerPopover`, so every load-bearing
 * visual works even when the host's Tailwind build never scanned this
 * package's sources (utility classes on these elements are progressive
 * enhancement only).
 *
 * Tokens — hosts may override any `--annotation-*` custom property anywhere
 * up the tree; the fallbacks below stand alone (light + dark via
 * `prefers-color-scheme`):
 *   --annotation-accent   ring border / primary button   (#6366f1)
 *   --annotation-surface  popover + chip background      (#ffffff / #1c1c20)
 *   --annotation-text     popover + chip text            (#18181b / #e4e4e7)
 *   --annotation-muted    secondary text                 (#71717a / #a1a1aa)
 *   --annotation-border   chip/popover/input borders     (rgba(0,0,0,.15) / rgba(255,255,255,.14))
 *   --annotation-danger   inline error text              (#dc2626 / #f87171)
 *
 * Also includes the glide transition — repositioning the persistent ring div
 * animates top/left/width/height so the highlight border slides between
 * targets instead of jumping.
 */
export const TARGETING_CSS = `
  [data-annotation-ring],
  [data-annotation-ring-selected],
  [data-annotation-chip],
  [data-annotation-composer] {
    --_annotation-accent: var(--annotation-accent, #6366f1);
    --_annotation-surface: var(--annotation-surface, #ffffff);
    --_annotation-text: var(--annotation-text, #18181b);
    --_annotation-muted: var(--annotation-muted, #71717a);
    --_annotation-border: var(--annotation-border, rgba(0, 0, 0, 0.15));
    --_annotation-danger: var(--annotation-danger, #dc2626);
  }
  @media (prefers-color-scheme: dark) {
    [data-annotation-ring],
    [data-annotation-ring-selected],
    [data-annotation-chip],
    [data-annotation-composer] {
      --_annotation-surface: var(--annotation-surface, #1c1c20);
      --_annotation-text: var(--annotation-text, #e4e4e7);
      --_annotation-muted: var(--annotation-muted, #a1a1aa);
      --_annotation-border: var(--annotation-border, rgba(255, 255, 255, 0.14));
      --_annotation-danger: var(--annotation-danger, #f87171);
    }
  }

  [data-annotation-ui="hover-ring"],
  [data-annotation-ui="hover-chip"],
  [data-annotation-ui="selected-ring"] {
    transition:
      top 120ms ease-out,
      left 120ms ease-out,
      width 120ms ease-out,
      height 120ms ease-out;
  }

  /* Annotate mode annotates — it never shows the native text highlight. The
     selection still EXISTS (the range math depends on it); the dotted drag
     ring is the only visible feedback. */
  [data-annotation-targeting="true"] ::selection {
    background: transparent;
  }
  [data-annotation-targeting="true"]::selection {
    background: transparent;
  }

  /* Rings — below chip below popover. The dotted border is the ENTIRE
     affordance: every ring (hover, live drag, selected) is fill-free, so the
     targeted content is never washed out or tinted. */
  [data-annotation-ring],
  [data-annotation-ring-selected] {
    position: absolute;
    pointer-events: none;
    box-sizing: border-box;
    z-index: 20;
    background: transparent;
    border: 2px dotted var(--_annotation-accent);
    border-style: dotted;
    border-radius: var(--radius, 6px);
  }

  /* Label chip. */
  [data-annotation-chip] {
    position: absolute;
    pointer-events: none;
    z-index: 30;
  }
  [data-annotation-chip] > span {
    display: inline-block;
    max-width: 280px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: var(--_annotation-surface);
    color: var(--_annotation-text);
    border: 1px solid var(--_annotation-border);
    border-radius: 6px;
    padding: 2px 6px;
    font-size: 11px;
    line-height: 1.5;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  }

  /* Composer popover — solid opaque surface, never host-CSS-dependent. */
  [data-annotation-composer] {
    position: absolute;
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-sizing: border-box;
    width: 360px;
    max-width: 90%;
    padding: 12px;
    background: var(--_annotation-surface);
    color: var(--_annotation-text);
    border: 1px solid var(--_annotation-border);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    font-size: 13px;
    text-align: left;
  }
  [data-annotation-composer-header] {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
  }
  [data-annotation-composer-label] {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
    font-weight: 500;
    color: var(--_annotation-muted);
  }
  [data-annotation-scopes] {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 2px;
    min-width: 0;
    font-size: 11px;
    color: var(--_annotation-muted);
  }
  [data-annotation-scope] {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    background: transparent;
    border: none;
    padding: 1px 4px;
    border-radius: 4px;
    font: inherit;
    font-size: 11px;
    font-weight: 500;
    color: var(--_annotation-muted);
    cursor: pointer;
  }
  [data-annotation-scope]:hover {
    color: var(--_annotation-text);
    background: color-mix(in srgb, var(--_annotation-accent) 8%, transparent);
  }
  [data-annotation-scope][aria-pressed="true"] {
    color: var(--_annotation-accent);
    background: color-mix(in srgb, var(--_annotation-accent) 10%, transparent);
    cursor: default;
  }
  [data-annotation-composer] textarea {
    box-sizing: border-box;
    width: 100%;
    min-height: 80px;
    padding: 8px 10px;
    background: var(--_annotation-surface);
    color: var(--_annotation-text);
    border: 1px solid var(--_annotation-border);
    border-radius: 6px;
    font: inherit;
    font-size: 13px;
    resize: none;
  }
  [data-annotation-composer] textarea::placeholder {
    color: var(--_annotation-muted);
  }
  [data-annotation-composer] [data-slot="button"] {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
  }
  [data-annotation-composer] [data-slot="button"][data-variant="default"] {
    background: var(--_annotation-accent);
    color: #ffffff;
    padding: 6px 12px;
  }
  [data-annotation-composer] [data-slot="button"][data-variant="ghost"] {
    background: transparent;
    color: var(--_annotation-muted);
    padding: 4px 6px;
  }
  [data-annotation-composer] [data-slot="button"]:disabled {
    opacity: 0.5;
    cursor: default;
    pointer-events: none;
  }
  [data-annotation-composer] svg {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
  }
  [data-annotation-composer-intent] {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: transparent;
    color: var(--_annotation-muted);
    border: 1px solid var(--_annotation-border);
    border-radius: 6px;
    padding: 4px 8px;
    font: inherit;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
  }
  [data-annotation-composer-intent][aria-pressed="true"] {
    color: var(--_annotation-accent);
    border-color: var(--_annotation-accent);
    background: color-mix(in srgb, var(--_annotation-accent) 10%, transparent);
  }
  [data-annotation-composer-error] {
    font-size: 11px;
    color: var(--_annotation-danger);
  }
  [data-annotation-composer-footer] {
    display: flex;
    justify-content: flex-end;
  }
`;

export type OverlayRect = { top: number; left: number; width: number; height: number };

/** How far the ring extends past the target's union rect on every side. */
const RING_INSET = 3;
/** How far above the ring the label chip sits. */
const CHIP_LIFT = 24;

function rectsEqual(a: OverlayRect | null, b: OverlayRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height
  );
}

function sameElementList(a: HTMLElement[] | null, b: HTMLElement[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((element, index) => element === b[index]);
}

/**
 * Union bounding rect of `elements`, in the content coordinates of the
 * positioned `container` (scroll offsets included). Shared by the targeting
 * overlays and the anchored composer popover — the single source of truth for
 * "where is this multi-element target" geometry.
 */
export function measureUnionRect(
  elements: HTMLElement[],
  container: HTMLElement,
): OverlayRect | null {
  let top = Infinity;
  let left = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  let any = false;

  for (const element of elements) {
    if (!element.isConnected) continue;
    const rect = element.getBoundingClientRect();
    top = Math.min(top, rect.top);
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
    any = true;
  }

  if (!any) return null;
  const containerRect = container.getBoundingClientRect();
  return {
    top: top - containerRect.top + container.scrollTop,
    left: left - containerRect.left + container.scrollLeft,
    width: right - left,
    height: bottom - top,
  };
}

/**
 * Bounding rect of the live DOM selection, in the content coordinates of the
 * positioned `container` (scroll offsets included) — the geometry of the
 * in-progress drag ring. Union of the selection range's client rects, falling
 * back to the range's own bounding rect when the environment reports none.
 * Exported so tests can exercise it directly; happy-dom lacks real layout, so
 * tests stub `Range.getClientRects` / `Range.getBoundingClientRect`.
 */
export function measureSelectionRect(
  selection: Selection | null,
  container: HTMLElement,
): OverlayRect | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (
    !container.contains(range.startContainer) &&
    !container.contains(range.endContainer)
  ) {
    return null;
  }

  const rects: Array<Pick<DOMRect, "top" | "left" | "right" | "bottom">> = [];
  if (typeof range.getClientRects === "function") {
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width > 0 || rect.height > 0) rects.push(rect);
    }
  }
  if (rects.length === 0 && typeof range.getBoundingClientRect === "function") {
    const rect = range.getBoundingClientRect();
    if (rect && (rect.width > 0 || rect.height > 0)) rects.push(rect);
  }
  if (rects.length === 0) return null;

  let top = Infinity;
  let left = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    top = Math.min(top, rect.top);
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  const containerRect = container.getBoundingClientRect();
  return {
    top: top - containerRect.top + container.scrollTop,
    left: left - containerRect.left + container.scrollLeft,
    width: right - left,
    height: bottom - top,
  };
}

/**
 * The container plus every scrolling ancestor (overflow auto/scroll/overlay).
 * Walked once per listener attach — the docs layer only watched the
 * immediate parent and went stale inside nested scrollers.
 */
function scrollListenTargets(container: HTMLElement): HTMLElement[] {
  const targets: HTMLElement[] = [container];
  const win = container.ownerDocument.defaultView;
  let node = container.parentElement;
  while (node) {
    if (win) {
      const style = win.getComputedStyle(node);
      const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
      if (/(auto|scroll|overlay)/.test(overflow)) targets.push(node);
    }
    node = node.parentElement;
  }
  return targets;
}

function nodeInsideSkip(node: Node, selector: string, container: HTMLElement): boolean {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  const hit = element?.closest(selector);
  return !!hit && container.contains(hit);
}

/**
 * Was the configured range modifier held on the releasing event? Both mouse
 * and keyboard events expose the modifier booleans, so one check covers the
 * mouseup and keyup paths. `"meta"` accepts Ctrl as well — Cmd on macOS,
 * Ctrl everywhere else.
 */
function rangeModifierHeld(
  modifier: RangeModifier,
  event: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
): boolean {
  switch (modifier) {
    case "meta":
      return event.metaKey || event.ctrlKey;
    case "alt":
      return event.altKey;
    case "shift":
      return event.shiftKey;
    case "none":
      return true;
  }
}

function hasNonCollapsedSelectionIn(container: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  return (
    container.contains(range.startContainer) || container.contains(range.endContainer)
  );
}

export function useTargeting<TTarget>({
  active,
  resolveTarget,
  onTargetSelect,
  onRangeSelect,
  rangeModifier = "none",
  resolveSelected,
  resolveToken,
  skipSelector,
  suppressHover,
}: TargetingOptions<TTarget>): Targeting<TTarget> {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hoverTarget, setHoverTarget] = useState<ResolvedTarget<TTarget> | null>(null);
  const [selectedElements, setSelectedElements] = useState<HTMLElement[] | null>(null);
  const [hoverRect, setHoverRect] = useState<OverlayRect | null>(null);
  const [selectedRect, setSelectedRect] = useState<OverlayRect | null>(null);
  /**
   * The in-progress mouse drag, or null. `modifier` records whether the
   * range modifier has been held at ANY point of the drag (sampled at
   * mousedown and re-sampled on every mousemove) — the releasing mouseup may
   * arrive after the user already let go of Cmd, and the range must not drop.
   */
  const dragRef = useRef<{ modifier: boolean } | null>(null);
  /**
   * Live drag ring geometry: the current selection's bounding rect while a
   * MODIFIED drag is in progress and the selection is non-collapsed. Null
   * during plain drags and outside drags entirely.
   */
  const [dragRect, setDragRect] = useState<OverlayRect | null>(null);

  const mergedSkipSelector = skipSelector
    ? `${DEFAULT_SKIP_SELECTOR}, ${skipSelector}`
    : DEFAULT_SKIP_SELECTOR;

  const hoverTargetRef = useRef(hoverTarget);
  hoverTargetRef.current = hoverTarget;
  const selectedElementsRef = useRef(selectedElements);
  selectedElementsRef.current = selectedElements;

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const hover = hoverTargetRef.current;
    const nextHoverRect = hover ? measureUnionRect(hover.elements, container) : null;
    setHoverRect((previous) => (rectsEqual(previous, nextHoverRect) ? previous : nextHoverRect));
    const selected = selectedElementsRef.current;
    const nextSelectedRect =
      selected && selected.length > 0 ? measureUnionRect(selected, container) : null;
    setSelectedRect((previous) =>
      rectsEqual(previous, nextSelectedRect) ? previous : nextSelectedRect,
    );
  }, []);

  // Deactivation drops every piece of transient state.
  useEffect(() => {
    if (active) return;
    setHoverTarget(null);
    setSelectedElements(null);
    setDragRect(null);
    dragRef.current = null;
  }, [active]);

  // A mouseup ANYWHERE ends the drag — the pointer may be released outside
  // the container (or outside the window on browsers that still deliver the
  // event), and the live ring must not stick around. Window-level and in
  // bubble phase, so the container's own mouseup (which reads the drag state)
  // has already run.
  useEffect(() => {
    if (!active) return;
    const clear = () => {
      dragRef.current = null;
      setDragRect((previous) => (previous === null ? previous : null));
    };
    window.addEventListener("mouseup", clear);
    return () => {
      window.removeEventListener("mouseup", clear);
      clear();
    };
  }, [active]);

  // Hover suppression (host composer open) drops any lingering hover state.
  useEffect(() => {
    if (!suppressHover) return;
    setHoverTarget((previous) => (previous === null ? previous : null));
  }, [suppressHover]);

  // Controlled selected ring: re-resolve on mount, on resolver change and on
  // `resolveToken` bumps (annotations/content changed underneath us).
  useLayoutEffect(() => {
    if (!active || !resolveSelected) {
      setSelectedElements((previous) => (previous === null ? previous : null));
      return;
    }
    const next = resolveSelected();
    setSelectedElements((previous) => (sameElementList(previous, next) ? previous : next));
  }, [active, resolveSelected, resolveToken]);

  // Geometry: measure synchronously on hover/selection change, then once more
  // on the next animation frame to catch late layout.
  useLayoutEffect(() => {
    if (!active) {
      setHoverRect(null);
      setSelectedRect(null);
      return;
    }
    measure();
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [active, hoverTarget, selectedElements, measure]);

  // Geometry: track window resize/scroll plus the container and every
  // scrolling ancestor (passive, rAF-coalesced). The container listener is
  // CAPTURE-phase: `scroll` does not bubble, but it does capture-propagate,
  // so this is what catches DESCENDANT scrollers (a scrollable editor pane
  // inside the container) — without it the rings freeze in place while the
  // content scrolls under them.
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    const win = container.ownerDocument.defaultView ?? window;

    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };

    const targets = scrollListenTargets(container);
    win.addEventListener("resize", schedule);
    win.addEventListener("scroll", schedule, { passive: true });
    container.addEventListener("scroll", schedule, { capture: true, passive: true });
    for (const target of targets) {
      target.addEventListener("scroll", schedule, { passive: true });
    }

    return () => {
      cancelAnimationFrame(raf);
      win.removeEventListener("resize", schedule);
      win.removeEventListener("scroll", schedule);
      container.removeEventListener("scroll", schedule, { capture: true });
      for (const target of targets) {
        target.removeEventListener("scroll", schedule);
      }
    };
  }, [active, measure]);

  const handleMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (!active) return;
      if (event.button !== 0) return;
      const container = containerRef.current;
      const raw = event.target;
      if (!container || !(raw instanceof Node) || !container.contains(raw)) return;
      // A fresh press starts a fresh potential drag. The modifier is sampled
      // NOW — holding Cmd when the drag starts is enough (see rangeModifier).
      dragRef.current = { modifier: rangeModifierHeld(rangeModifier, event) };
      setDragRect((previous) => (previous === null ? previous : null));
    },
    [active, rangeModifier],
  );

  const handleMouseMove = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (!active) return;
      const container = containerRef.current;

      // Live drag ring: while a modified drag is in progress and the native
      // selection is non-collapsed, the dotted ring tracks the selection's
      // bounding rect and the hover affordance stands down entirely.
      const drag = dragRef.current;
      if (drag && container) {
        // Pressing the modifier mid-drag still counts for this drag.
        if (!drag.modifier) drag.modifier = rangeModifierHeld(rangeModifier, event);
        if (rangeModifier !== "none" && drag.modifier && onRangeSelect) {
          const rect = measureSelectionRect(window.getSelection(), container);
          if (rect) {
            setDragRect((previous) => (rectsEqual(previous, rect) ? previous : rect));
            if (hoverTargetRef.current) setHoverTarget(null);
            return;
          }
          setDragRect((previous) => (previous === null ? previous : null));
        }
      }

      if (suppressHover) return;
      const raw = event.target;
      if (!container || !(raw instanceof HTMLElement) || !container.contains(raw)) {
        return;
      }
      if (raw.closest(mergedSkipSelector)) {
        if (hoverTargetRef.current) setHoverTarget(null);
        return;
      }
      const resolved = resolveTarget(raw);
      if (!resolved || resolved.elements.length === 0) {
        if (hoverTargetRef.current) setHoverTarget(null);
        return;
      }
      // Identical resolution (same first element + same label) must not
      // re-set state — mousemove fires constantly.
      const current = hoverTargetRef.current;
      if (
        current &&
        current.elements[0] === resolved.elements[0] &&
        current.label === resolved.label
      ) {
        return;
      }
      setHoverTarget(resolved);
    },
    [active, suppressHover, mergedSkipSelector, resolveTarget, rangeModifier, onRangeSelect],
  );

  const handleMouseLeave = useCallback(() => {
    if (hoverTargetRef.current) setHoverTarget(null);
  }, []);

  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (!active || !onTargetSelect) return;
      const container = containerRef.current;
      const raw = event.target;
      if (!container || !(raw instanceof HTMLElement) || !container.contains(raw)) {
        return;
      }
      if (raw.closest(mergedSkipSelector)) return;
      if (hasNonCollapsedSelectionIn(container)) return;
      const resolved = resolveTarget(raw);
      if (!resolved || resolved.elements.length === 0) return;
      event.preventDefault();
      onTargetSelect(resolved);
    },
    [active, mergedSkipSelector, onTargetSelect, resolveTarget],
  );

  // The shared tail of the mouseup/keyup paths: read the DOM selection,
  // validate it against the container and skip elements, and report it.
  const emitRangeSelection = useCallback(() => {
    if (!active || !onRangeSelect) return;
    const container = containerRef.current;
    if (!container) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (
      !container.contains(range.startContainer) ||
      !container.contains(range.endContainer)
    ) {
      return;
    }
    if (
      nodeInsideSkip(range.startContainer, mergedSkipSelector, container) ||
      nodeInsideSkip(range.endContainer, mergedSkipSelector, container)
    ) {
      return;
    }
    onRangeSelect({ range, text: selection.toString() });
    // Annotate mode annotates: once the range is reported (whether or not the
    // host pinned it), the native selection has served its purpose. Clearing
    // it here keeps the document free of lingering highlights. (Guarded:
    // test-stubbed selections may not implement removeAllRanges.)
    if (typeof selection.removeAllRanges === "function") {
      selection.removeAllRanges();
    }
  }, [active, mergedSkipSelector, onRangeSelect]);

  const handleMouseUp = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      // The release always ends the drag (and retires the live ring), even
      // when the range is not reported.
      const drag = dragRef.current;
      dragRef.current = null;
      setDragRect((previous) => (previous === null ? previous : null));
      if (!active) return;
      // Range selection may be gated behind a modifier ("annotation mode is
      // the selector; hold Cmd to drag"). The modifier counts if it was held
      // at any point of the drag OR on this release — letting go of Cmd a
      // beat before the mouse must not drop the range.
      if (!drag?.modifier && !rangeModifierHeld(rangeModifier, event)) return;
      emitRangeSelection();
    },
    [active, rangeModifier, emitRangeSelection],
  );

  const handleKeyUp = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (!active) return;
      // Keyboard selections check the releasing keyup's modifier state.
      if (!rangeModifierHeld(rangeModifier, event)) return;
      emitRangeSelection();
    },
    [active, rangeModifier, emitRangeSelection],
  );

  // A drag that starts inside the container frequently RELEASES outside it
  // (sweeping past an edge) — the container's React mouseup never fires there,
  // which used to drop the range silently after the live ring had tracked the
  // whole drag. A window-level listener completes those drags. The container
  // handler nulls `dragRef` first thing, so a release inside the container is
  // never double-emitted here.
  useEffect(() => {
    if (!active || !onRangeSelect) return;
    const doc = containerRef.current?.ownerDocument ?? document;
    const completeDrag = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      setDragRect((previous) => (previous === null ? previous : null));
      if (!drag.modifier && !rangeModifierHeld(rangeModifier, event)) return;
      emitRangeSelection();
    };
    doc.addEventListener("mouseup", completeDrag);
    return () => {
      doc.removeEventListener("mouseup", completeDrag);
    };
  }, [active, onRangeSelect, rangeModifier, emitRangeSelection]);

  // Chip placement: the chip normally floats above the ring; when that would
  // clamp past the container top (and overlap preceding content), it renders
  // inside the ring's top-left instead.
  const hoverRingTop = hoverRect ? hoverRect.top - RING_INSET : 0;
  const hoverRingLeft = hoverRect ? hoverRect.left - RING_INSET : 0;
  const chipInside = hoverRect ? hoverRingTop - CHIP_LIFT < 0 : false;
  const chipTop = chipInside ? hoverRingTop + 4 : hoverRect ? hoverRect.top - CHIP_LIFT : 0;
  const chipLeft = chipInside ? hoverRingLeft + 4 : Math.max(0, hoverRingLeft);

  const overlays: ReactNode = active ? (
    <>
      <style data-annotation-ui="style">{TARGETING_CSS}</style>
      {!suppressHover && !dragRect && hoverTarget && hoverRect ? (
        <>
          <div
            data-annotation-ui="hover-ring"
            data-annotation-ring=""
            className="pointer-events-none absolute z-20 border-2 border-dotted border-primary"
            style={{
              top: hoverRingTop,
              left: hoverRingLeft,
              width: hoverRect.width + RING_INSET * 2,
              height: hoverRect.height + RING_INSET * 2,
              borderStyle: "dotted",
            }}
          />
          <div
            data-annotation-ui="hover-chip"
            data-annotation-chip=""
            data-annotation-chip-placement={chipInside ? "inside" : "above"}
            className="pointer-events-none absolute z-30"
            style={{
              top: chipTop,
              left: chipLeft,
            }}
          >
            <span className="inline-block max-w-[280px] overflow-hidden text-ellipsis whitespace-nowrap rounded-sm border bg-popover px-1.5 py-0.5 text-xs text-popover-foreground shadow-sm">
              {hoverTarget.label}
            </span>
          </div>
        </>
      ) : null}
      {/* Live drag ring: wraps the in-progress modified selection, updating
          on every mousemove. Same dotted-accent styling as the selected ring
          (the `data-annotation-ring-selected` attribute carries the CSS), but
          its own `data-annotation-ui` value keeps it OFF the glide transition
          so it tracks the pointer without lag. On release the pinned selected
          ring takes over through the host's normal range flow. */}
      {dragRect ? (
        <div
          data-annotation-ui="drag-ring"
          data-annotation-ring-selected=""
          className="pointer-events-none absolute z-20 border-2 border-dotted border-primary"
          style={{
            top: dragRect.top - RING_INSET,
            left: dragRect.left - RING_INSET,
            width: dragRect.width + RING_INSET * 2,
            height: dragRect.height + RING_INSET * 2,
            borderStyle: "dotted",
          }}
        />
      ) : null}
      {selectedRect ? (
        <div
          data-annotation-ui="selected-ring"
          data-annotation-ring-selected=""
          className="pointer-events-none absolute z-20 border-2 border-dotted border-primary"
          style={{
            top: selectedRect.top - RING_INSET,
            left: selectedRect.left - RING_INSET,
            width: selectedRect.width + RING_INSET * 2,
            height: selectedRect.height + RING_INSET * 2,
            borderStyle: "dotted",
          }}
        />
      ) : null}
    </>
  ) : null;

  return {
    containerRef,
    containerProps: {
      "data-annotation-targeting": active ? "true" : "false",
      onMouseDown: handleMouseDown,
      onMouseMove: handleMouseMove,
      onMouseLeave: handleMouseLeave,
      onClick: handleClick,
      onMouseUp: handleMouseUp,
      onKeyUp: handleKeyUp,
    },
    hoverTarget,
    overlays,
  };
}
