"use client";

/**
 * Generic annotation panel — composer + grouped annotation list over a host's
 * annotations. Target-agnostic: the host supplies `targetKey`/`targetLabel`
 * functions (which also define the grouping and the `data-plannotator-target`
 * attribute values) and precomputed `danglingReasons`; the panel never
 * inspects targets itself.
 *
 * Dangling targets (host says the target no longer resolves) never crash —
 * such annotations render a clearly-marked inert state instead of throwing
 * or silently disappearing.
 *
 * DOM contract: the `data-plannotator*` attributes and visible strings are a
 * compat surface inherited from the docs-system Plannotator; hosts (and their
 * tests) select on them. Follow-up: make the attribute prefix configurable.
 */

import { useMemo, useState, type ReactNode } from "react";
import { AlertTriangleIcon, CheckIcon, MessageSquarePlusIcon, SparklesIcon } from "lucide-react";
import type { Annotation } from "../core/index";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { cn } from "./ui/cn";
import {
  useAnnotations,
  type RunAgentResult,
  type UndoPatchResult,
  type AddAnnotationInput,
} from "./useAnnotations";

export type AnnotationPanelIntentOption = {
  value: string;
  label: string;
  hint: string;
};

const DEFAULT_INTENT_OPTIONS: AnnotationPanelIntentOption[] = [
  { value: "note", label: "Note", hint: "Just a note — no action requested." },
  { value: "agent-request", label: "Agent request", hint: "Ask an agent to act on this." },
];

const EMPTY_DANGLING: ReadonlyMap<string, string> = new Map();

export interface AnnotationPanelProps<TTarget> {
  /** All annotations for the current document (raw, unfiltered by status). */
  annotations: Annotation<TTarget>[];
  /** Current pending selection (set by the host in response to a target click). */
  selection: { target: TTarget; label?: string } | null;
  /** Stable grouping key for a target — also the `data-plannotator-target` attribute value. */
  targetKey: (target: TTarget) => string;
  /** Human label for a target. */
  targetLabel: (target: TTarget) => string;
  /**
   * annotationId → human-readable reason for annotations whose target no
   * longer resolves. Computed by the host (e.g. via its annotation schema's
   * `detectDanglingTargets`), not inside the panel.
   */
  danglingReasons?: ReadonlyMap<string, string>;
  /**
   * Composer intent choices. Defaults to the note / agent-request pair; the
   * first option is the initial (and post-submit reset) intent. The sparkles
   * icon renders for the "agent-request" value.
   */
  intentOptions?: AnnotationPanelIntentOption[];
  /** Clears the pending selection (e.g. composer cancel). */
  onClearSelection: () => void;
  /** Submits a new annotation against `selection`. Host performs the actual API call. */
  onAddAnnotation: (input: AddAnnotationInput<TTarget>) => Promise<void>;
  /** Marks an annotation resolved. Host performs the actual API call. */
  onResolveAnnotation: (annotationId: string) => Promise<void>;
  /** Jumps the host viewer to an annotation's target. */
  onFocusTarget?: (target: TTarget) => void;
  /** Kicks off an agent run. Optional — omit to not render the Run-agent button at all. */
  onRunAgent?: (annotationId: string) => Promise<RunAgentResult>;
  /** Undoes a previously-applied agent patch. Optional — omit to not render the Undo button at all. */
  onUndoPatch?: (patchId: string, changedIds?: string[]) => Promise<UndoPatchResult>;
  /**
   * Adds a reply to an annotation's thread. Optional — when present, every
   * OPEN annotation gets a "Reply" affordance revealing an inline composer;
   * absent, threads render read-only and no affordance appears.
   */
  onAddReply?: (annotationId: string, body: string) => Promise<void>;
  isSubmitting?: boolean;
  className?: string;
  /**
   * Render the inline composer for the pending selection. Default true. Hosts
   * using the anchored `AnnotationComposerPopover` instead pass false — the
   * panel then renders the list only (pair with an `emptyState` that does not
   * reference the composer).
   */
  showComposer?: boolean;
  /** Empty-list content. Defaults to the standard "No annotations yet" copy. */
  emptyState?: ReactNode;
}

/** Groups annotations by target so the list can show one entry with an open-count per target. */
function groupByTarget<TTarget>(
  annotations: Annotation<TTarget>[],
  targetKey: (target: TTarget) => string,
): Map<string, Annotation<TTarget>[]> {
  const groups = new Map<string, Annotation<TTarget>[]>();
  for (const annotation of annotations) {
    const key = targetKey(annotation.target);
    const existing = groups.get(key);
    if (existing) existing.push(annotation);
    else groups.set(key, [annotation]);
  }
  return groups;
}

export function AnnotationPanel<TTarget>({
  annotations,
  selection,
  targetKey,
  targetLabel,
  danglingReasons = EMPTY_DANGLING,
  intentOptions = DEFAULT_INTENT_OPTIONS,
  onClearSelection,
  onAddAnnotation,
  onResolveAnnotation,
  onFocusTarget,
  onRunAgent,
  onUndoPatch,
  onAddReply,
  isSubmitting,
  className,
  showComposer = true,
  emptyState,
}: AnnotationPanelProps<TTarget>) {
  const {
    body,
    setBody,
    intent,
    setIntent,
    error,
    runningAgentIds,
    undoingPatchIds,
    undonePatchIds,
    agentErrors,
    submit,
    resolve,
    runAgent,
    undoPatch,
  } = useAnnotations<TTarget>({
    target: selection ? selection.target : null,
    defaultIntent: intentOptions[0]?.value ?? "note",
    onAddAnnotation,
    onResolveAnnotation,
    onClearSelection,
    onRunAgent,
    onUndoPatch,
  });

  const groups = useMemo(() => groupByTarget(annotations, targetKey), [annotations, targetKey]);

  // Inline reply composer — one open at a time, keyed by annotation id.
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replySubmitting, setReplySubmitting] = useState(false);

  const openReply = (annotationId: string) => {
    setReplyingId(annotationId);
    setReplyBody("");
    setReplyError(null);
  };

  const closeReply = () => {
    setReplyingId(null);
    setReplyBody("");
    setReplyError(null);
  };

  const submitReply = async (annotationId: string) => {
    if (!onAddReply) return;
    const trimmed = replyBody.trim();
    if (!trimmed) return;
    setReplyError(null);
    setReplySubmitting(true);
    try {
      await onAddReply(annotationId, trimmed);
      closeReply();
    } catch (replySubmitError) {
      setReplyError(
        replySubmitError instanceof Error ? replySubmitError.message : "Failed to add reply.",
      );
    } finally {
      setReplySubmitting(false);
    }
  };

  return (
    <div className={cn("flex flex-col gap-4", className)} data-plannotator="root">
      {showComposer && selection && (
        <div
          className="flex flex-col gap-2 rounded-md border bg-popover p-3 shadow-sm"
          data-plannotator="composer"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              Annotating: {selection.label ?? targetLabel(selection.target)}
            </span>
            <Button type="button" variant="ghost" size="xs" onClick={onClearSelection}>
              Cancel
            </Button>
          </div>

          {intentOptions.length > 1 && (
            <div className="flex gap-1">
              {intentOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  data-plannotator-intent={option.value}
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
              intent === "agent-request"
                ? "Describe what you want an agent to do..."
                : "Add an annotation..."
            }
            className="min-h-20 resize-none text-sm"
          />

          {error && <div className="text-xs text-destructive">{error}</div>}

          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={!body.trim() || isSubmitting}
              onClick={() => void submit()}
            >
              <MessageSquarePlusIcon className="h-3.5 w-3.5" />
              {isSubmitting ? "Posting..." : "Post annotation"}
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3" data-plannotator="list">
        {groups.size === 0 && (
          <div className="text-sm text-muted-foreground">
            {emptyState ?? "No annotations yet. Select a block or canvas object to start one."}
          </div>
        )}

        {Array.from(groups.entries()).map(([key, group]) => {
          const openCount = group.filter((a) => a.status === "open").length;
          const target = group[0].target;
          const dangling = group.find((a) => danglingReasons.has(a.id));

          return (
            <div
              key={key}
              className="flex flex-col gap-2 rounded-md border p-3"
              data-plannotator-target={key}
            >
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  className="text-left text-xs font-medium text-muted-foreground hover:text-foreground"
                  onClick={() => onFocusTarget?.(target)}
                  disabled={!onFocusTarget || Boolean(dangling)}
                >
                  {targetLabel(target)}
                </button>
                <div className="flex items-center gap-1">
                  {dangling && (
                    <Badge variant="destructive" className="gap-1">
                      <AlertTriangleIcon className="h-3 w-3" />
                      Target removed
                    </Badge>
                  )}
                  {openCount > 0 && <Badge variant="secondary">{openCount} open</Badge>}
                </div>
              </div>

              {dangling && (
                <div className="text-xs text-muted-foreground" data-plannotator-dangling-reason="">
                  {danglingReasons.get(dangling.id)}
                </div>
              )}

              <div className="flex flex-col gap-2">
                {group.map((annotation) => (
                  <div
                    key={annotation.id}
                    className="flex flex-col gap-1 rounded-sm border bg-muted/20 p-2"
                    data-plannotator-annotation-id={annotation.id}
                    data-plannotator-annotation-status={annotation.status}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{annotation.author}</span>
                        {annotation.intent === "agent-request" && (
                          <Badge variant="outline" className="gap-1">
                            <SparklesIcon className="h-3 w-3" />
                            Agent request
                          </Badge>
                        )}
                        <span>{new Date(annotation.createdAt).toLocaleString()}</span>
                      </div>
                      {annotation.status === "open" && (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() => void resolve(annotation.id)}
                        >
                          <CheckIcon className="h-3.5 w-3.5" />
                          Resolve
                        </Button>
                      )}
                      {annotation.status === "resolved" && (
                        <Badge variant="secondary" className="gap-1">
                          <CheckIcon className="h-3 w-3" />
                          Resolved
                        </Badge>
                      )}
                      {annotation.intent === "agent-request" &&
                        annotation.status === "open" &&
                        !annotation.agentRun &&
                        onRunAgent && (
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            disabled={runningAgentIds.has(annotation.id)}
                            onClick={() => void runAgent(annotation.id)}
                          >
                            <SparklesIcon className="h-3.5 w-3.5" />
                            {runningAgentIds.has(annotation.id) ? "Running..." : "Run agent"}
                          </Button>
                        )}
                    </div>
                    <p className="whitespace-pre-wrap text-sm">{annotation.body}</p>
                    {annotation.agentRun && (
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs text-muted-foreground">
                          Agent run: {annotation.agentRun.summary}
                        </div>
                        {onUndoPatch && (
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            disabled={
                              undoingPatchIds.has(annotation.id) || undonePatchIds.has(annotation.id)
                            }
                            onClick={() =>
                              void undoPatch(
                                annotation.id,
                                annotation.agentRun!.patchId,
                                annotation.agentRun!.changedIds,
                              )
                            }
                          >
                            {undonePatchIds.has(annotation.id)
                              ? "Undone"
                              : undoingPatchIds.has(annotation.id)
                                ? "Undoing..."
                                : "Undo"}
                          </Button>
                        )}
                      </div>
                    )}
                    {agentErrors[annotation.id] && (
                      <div className="text-xs text-destructive" data-plannotator-agent-error="">
                        {agentErrors[annotation.id]}
                      </div>
                    )}
                    {annotation.replies && annotation.replies.length > 0 && (
                      <div
                        className="mt-1 flex flex-col gap-1.5 border-l-2 border-border pl-2"
                        style={{ marginLeft: 4, paddingLeft: 8, borderLeft: "2px solid rgba(128, 128, 128, 0.25)" }}
                        data-plannotator-replies=""
                      >
                        {annotation.replies.map((reply) => (
                          <div
                            key={reply.id}
                            className="flex flex-col gap-0.5 rounded-sm bg-muted/20 p-1.5"
                            data-annotation-reply-id={reply.id}
                          >
                            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                              <span className="font-medium text-foreground">{reply.author}</span>
                              <span>{new Date(reply.createdAt).toLocaleString()}</span>
                            </div>
                            <p className="whitespace-pre-wrap text-xs">{reply.body}</p>
                          </div>
                        ))}
                      </div>
                    )}
                    {onAddReply &&
                      annotation.status === "open" &&
                      (replyingId === annotation.id ? (
                        <div className="flex flex-col gap-1" data-plannotator-reply-composer="">
                          <Textarea
                            autoFocus
                            value={replyBody}
                            onChange={(event) => setReplyBody(event.target.value)}
                            onKeyDown={(event) => {
                              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                                event.preventDefault();
                                void submitReply(annotation.id);
                              }
                            }}
                            rows={2}
                            placeholder="Reply..."
                            className="min-h-12 resize-none text-xs"
                          />
                          {replyError && (
                            <div className="text-xs text-destructive" data-plannotator-reply-error="">
                              {replyError}
                            </div>
                          )}
                          <div className="flex justify-end gap-1">
                            <Button type="button" size="xs" variant="ghost" onClick={closeReply}>
                              Cancel
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              data-plannotator-reply-submit=""
                              disabled={!replyBody.trim() || replySubmitting}
                              onClick={() => void submitReply(annotation.id)}
                            >
                              {replySubmitting ? "Replying..." : "Reply"}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex justify-start">
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            data-plannotator-reply-open=""
                            onClick={() => openReply(annotation.id)}
                          >
                            Reply
                          </Button>
                        </div>
                      ))}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
