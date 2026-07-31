"use client";

/**
 * Anchored annotation composer — a popover that sits next to the pinned
 * target (the elements the host just clicked) instead of living in a side
 * panel. Renders inside the same `position: relative` container as the
 * targeting overlays; it self-measures the anchors' union rect relative to
 * its positioned ancestor via the shared `measureUnionRect` helper.
 *
 * Positioning: below the anchor rect (rect.bottom + gap), clamped inside the
 * container horizontally, flipped above when there is no room below.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { MessageSquarePlusIcon, SparklesIcon, XIcon } from "lucide-react";
import type { AnnotationPanelIntentOption } from "../AnnotationPanel";
import { useComposerDraft } from "../useAnnotations";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { cn } from "../ui/cn";
import { measureUnionRect, TARGETING_CSS } from "./useTargeting";

const DEFAULT_INTENT_OPTIONS: AnnotationPanelIntentOption[] = [
  {
    value: "agent-request",
    label: "Agent request",
    hint: "Ask an agent to act on this.",
  },
];

/** Gap between the anchor rect and the popover, in px. */
const ANCHOR_GAP = 8;

/**
 * One entry in the composer's scope breadcrumb — an ancestor of the pinned
 * target the user can widen the annotation to (bullet → whole list →
 * section).
 */
export type AnnotationComposerScope = { key: string; label: string };

export interface AnnotationComposerPopoverProps {
  /**
   * Anchor elements (the pinned target's rows/element); the popover
   * self-measures their union rect relative to the positioned container it
   * renders inside. Null/empty → renders nothing.
   */
  anchorElements: HTMLElement[] | null;
  /** Label of what's being annotated, shown in the popover header. */
  targetLabel: string;
  /**
   * Single fixed intent (no picker) OR multiple options (picker shown) —
   * same option shape as AnnotationPanel. Default: single "agent-request".
   */
  intentOptions?: AnnotationPanelIntentOption[];
  onSubmit: (input: { body: string; intent: string }) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
  placeholder?: string;
  /**
   * Ancestor chain of the pinned target, ordered leaf-first (e.g. list item →
   * bullet list → section). With 2+ entries the header renders a clickable
   * breadcrumb instead of the plain `targetLabel`, letting the user widen the
   * target without modifier keys. Absent/single-entry → plain `targetLabel`.
   */
  scopes?: AnnotationComposerScope[];
  /** Key of the currently-active scope segment (highlighted, `aria-pressed`). */
  activeScopeKey?: string;
  /**
   * Scope segment clicked. The HOST re-anchors/re-targets (ring moves via its
   * own resolveSelected/anchorElements update); the popover only reports.
   */
  onScopeChange?: (key: string) => void;
}

export function AnnotationComposerPopover({
  anchorElements,
  targetLabel,
  intentOptions = DEFAULT_INTENT_OPTIONS,
  onSubmit,
  onCancel,
  isSubmitting,
  placeholder,
  scopes,
  activeScopeKey,
  onScopeChange,
}: AnnotationComposerPopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    placement: "below" | "above";
  } | null>(null);

  const anchorsRef = useRef(anchorElements);
  anchorsRef.current = anchorElements;

  const { body, setBody, intent, setIntent, error, submit } = useComposerDraft({
    defaultIntent: intentOptions[0]?.value ?? "agent-request",
    onSubmit,
  });

  const measure = useCallback(() => {
    const popover = popoverRef.current;
    const anchors = anchorsRef.current;
    if (!popover || !anchors || anchors.length === 0) return;
    const container =
      popover.offsetParent instanceof HTMLElement
        ? popover.offsetParent
        : popover.parentElement;
    if (!(container instanceof HTMLElement)) return;
    const rect = measureUnionRect(anchors, container);
    if (!rect) return;

    const popoverWidth = popover.offsetWidth || 320;
    const popoverHeight = popover.offsetHeight;

    // Horizontal: anchor-left, clamped inside the container.
    const maxLeft = Math.max(0, container.clientWidth - popoverWidth);
    const left = Math.min(Math.max(0, rect.left), maxLeft);

    // Vertical: below the anchor; flip above only when below overflows the
    // container's content bottom AND there is room above. Never positioned
    // over the anchor rect itself — when neither side fits it stays below
    // (overflowing) rather than covering the anchor.
    let top = rect.top + rect.height + ANCHOR_GAP;
    let placement: "below" | "above" = "below";
    const contentBottom = Math.max(container.scrollHeight, container.clientHeight);
    if (top + popoverHeight > contentBottom) {
      const above = rect.top - ANCHOR_GAP - popoverHeight;
      if (above >= 0) {
        top = above;
        placement = "above";
      }
    }

    setPosition((previous) =>
      previous &&
      previous.top === top &&
      previous.left === left &&
      previous.placement === placement
        ? previous
        : { top, left, placement },
    );
  }, []);

  const hasAnchors = !!anchorElements && anchorElements.length > 0;

  // Re-measure synchronously on anchor change, then once more on the next
  // frame to catch late layout (mirrors the targeting overlays).
  useLayoutEffect(() => {
    if (!hasAnchors) return;
    measure();
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [hasAnchors, anchorElements, measure]);

  // Track window resize/scroll (rAF-coalesced, simplified from the targeting
  // layer's ancestor walk — scroll listens in capture to catch nested scrollers).
  useEffect(() => {
    if (!hasAnchors) return;
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, { capture: true });
    };
  }, [hasAnchors, measure]);

  if (!hasAnchors) return null;

  const showScopes = !!scopes && scopes.length >= 2;

  return (
    <>
      <style data-annotation-ui="style">{TARGETING_CSS}</style>
      <div
        ref={popoverRef}
        data-annotation-ui="composer-popover"
        data-annotation-composer=""
        data-annotation-composer-placement={position?.placement ?? "below"}
        className="absolute z-40 flex w-[360px] max-w-[90%] flex-col gap-2 rounded-md border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
        style={{ top: position?.top ?? 0, left: position?.left ?? 0 }}
      >
        <div
          data-annotation-composer-header=""
          className="flex items-center justify-between gap-2"
        >
          {showScopes ? (
            <div data-annotation-scopes="" className="flex min-w-0 flex-wrap items-center gap-0.5">
              {scopes.map((scope, index) => (
                <span key={scope.key} className="flex items-center gap-0.5">
                  {index > 0 && <span aria-hidden="true">›</span>}
                  <button
                    type="button"
                    data-annotation-scope={scope.key}
                    aria-pressed={scope.key === activeScopeKey}
                    onClick={() => onScopeChange?.(scope.key)}
                    className={cn(
                      "rounded-sm px-0.5 text-xs font-medium",
                      scope.key === activeScopeKey
                        ? "text-primary"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {scope.label}
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <span
              data-annotation-composer-label=""
              className="overflow-hidden text-ellipsis whitespace-nowrap text-xs font-medium text-muted-foreground"
            >
              {targetLabel}
            </span>
          )}
          <Button type="button" variant="ghost" size="xs" aria-label="Cancel" onClick={onCancel}>
            <XIcon className="h-3.5 w-3.5" />
          </Button>
        </div>

      {intentOptions.length > 1 && (
        <div className="flex gap-1">
          {intentOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              data-annotation-composer-intent={option.value}
              aria-pressed={intent === option.value}
              title={option.hint}
              onClick={() => setIntent(option.value)}
              className={cn(
                "flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                intent === option.value
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:bg-muted/50",
              )}
            >
              {option.value === "agent-request" && <SparklesIcon className="h-3 w-3" />}
              {option.label}
            </button>
          ))}
        </div>
      )}

      <Textarea
        autoFocus
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
        rows={3}
        placeholder={
          placeholder ??
          (intent === "agent-request"
            ? "Describe what you want an agent to do..."
            : "Add an annotation...")
        }
        className="min-h-20 resize-none text-sm"
      />

        {error && (
          <div data-annotation-composer-error="" className="text-xs text-destructive">
            {error}
          </div>
        )}

        <div data-annotation-composer-footer="" className="flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={!body.trim() || isSubmitting}
            onClick={() => void submit()}
          >
            <MessageSquarePlusIcon className="h-3.5 w-3.5" />
            {isSubmitting ? "Posting..." : "Annotate"}
          </Button>
        </div>
      </div>
    </>
  );
}
