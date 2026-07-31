"use client";

/**
 * Headless annotation-panel state — the composer draft, per-annotation agent
 * run/undo in-flight tracking, and error capture, without any UI. Zones that
 * build their own panel UI use this directly; `AnnotationPanel` composes it
 * with the default presentation.
 *
 * The hook is intentionally decoupled from any backend contract — the host
 * supplies async callbacks (`onAddAnnotation`, `onResolveAnnotation`,
 * `onRunAgent`, `onUndoPatch`) and owns the actual fetch/mutation wiring.
 */

import { useState } from "react";

/** Result of a host `onRunAgent` call. */
export type RunAgentResult =
  | { ok: true; summary: string; patchId: string; changedIds: string[] }
  | { ok: false; detail: string };

/** Result of a host `onUndoPatch` call. */
export type UndoPatchResult = { ok: true } | { ok: false; detail: string };

/** Payload the hook hands to `onAddAnnotation` on submit. */
export type AddAnnotationInput<TTarget> = {
  target: TTarget;
  body: string;
  intent: string;
};

export interface UseAnnotationsOptions<TTarget> {
  /** The pending selection's target, or null when nothing is selected. `submit` no-ops while null. */
  target: TTarget | null;
  /** Intent the composer starts with and resets to after a successful submit. Defaults to "note". */
  defaultIntent?: string;
  /** Submits a new annotation against `target`. Host performs the actual API call. */
  onAddAnnotation: (input: AddAnnotationInput<TTarget>) => Promise<void>;
  /** Marks an annotation resolved. Host performs the actual API call. */
  onResolveAnnotation: (annotationId: string) => Promise<void>;
  /** Clears the pending selection (called after a successful submit). */
  onClearSelection: () => void;
  /** Kicks off an agent run for an annotation. Omit when the host has no agent runner. */
  onRunAgent?: (annotationId: string) => Promise<RunAgentResult>;
  /** Undoes a previously-applied agent patch. Omit when the host has no undo. */
  onUndoPatch?: (patchId: string, changedIds?: string[]) => Promise<UndoPatchResult>;
}

export interface UseAnnotationsResult {
  /** Composer draft body. */
  body: string;
  setBody: (body: string) => void;
  /** Composer intent. */
  intent: string;
  setIntent: (intent: string) => void;
  /** Last submit error, or null. Cleared on the next submit attempt. */
  error: string | null;
  /** Annotation ids with an agent run currently in flight. */
  runningAgentIds: ReadonlySet<string>;
  /** Annotation ids with a patch undo currently in flight. */
  undoingPatchIds: ReadonlySet<string>;
  /** Annotation ids whose patch has been undone this session. */
  undonePatchIds: ReadonlySet<string>;
  /** Per-annotation agent run/undo error messages. */
  agentErrors: Readonly<Record<string, string>>;
  /**
   * Submits the composer draft against the current target. No-op when there
   * is no target or the trimmed body is empty. On success clears the draft,
   * resets the intent, and calls `onClearSelection`; on failure captures the
   * error message into `error`.
   */
  submit: () => Promise<void>;
  /** Marks an annotation resolved (thin passthrough to `onResolveAnnotation`). */
  resolve: (annotationId: string) => Promise<void>;
  /** Runs the agent for an annotation, tracking in-flight state and capturing errors per annotation. */
  runAgent: (annotationId: string) => Promise<void>;
  /** Undoes an agent patch, tracking in-flight/undone state and capturing errors per annotation. */
  undoPatch: (annotationId: string, patchId: string, changedIds?: string[]) => Promise<void>;
}

/** Options for `useComposerDraft` — the target-agnostic composer core. */
export interface UseComposerDraftOptions {
  /** Intent the draft starts with and resets to after a successful submit. Defaults to "note". */
  defaultIntent?: string;
  /**
   * Receives the trimmed body + current intent. Throw (or reject) to surface
   * the error message into `error` instead of clearing the draft.
   */
  onSubmit: (input: { body: string; intent: string }) => Promise<void>;
}

/** Draft state + submit lifecycle shared by every composer surface. */
export interface UseComposerDraftResult {
  body: string;
  setBody: (body: string) => void;
  intent: string;
  setIntent: (intent: string) => void;
  /** Last submit error, or null. Cleared on the next submit attempt. */
  error: string | null;
  /**
   * Submits the trimmed draft. No-op on an empty body. On success clears the
   * body and resets the intent; on failure captures the message into `error`.
   */
  submit: () => Promise<void>;
}

/**
 * The composer draft core — body/intent state, trim + empty-body guard, and
 * submit error capture. `useAnnotations` layers target/selection handling on
 * top of this; `AnnotationComposerPopover` uses it directly.
 */
export function useComposerDraft({
  defaultIntent = "note",
  onSubmit,
}: UseComposerDraftOptions): UseComposerDraftResult {
  const [body, setBody] = useState("");
  const [intent, setIntent] = useState(defaultIntent);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!body.trim()) return;
    setError(null);
    try {
      await onSubmit({ body: body.trim(), intent });
      setBody("");
      setIntent(defaultIntent);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to add annotation.");
    }
  };

  return { body, setBody, intent, setIntent, error, submit };
}

export function useAnnotations<TTarget>({
  target,
  defaultIntent = "note",
  onAddAnnotation,
  onResolveAnnotation,
  onClearSelection,
  onRunAgent,
  onUndoPatch,
}: UseAnnotationsOptions<TTarget>): UseAnnotationsResult {
  const [runningAgentIds, setRunningAgentIds] = useState<Set<string>>(new Set());
  const [undoingPatchIds, setUndoingPatchIds] = useState<Set<string>>(new Set());
  const [undonePatchIds, setUndonePatchIds] = useState<Set<string>>(new Set());
  const [agentErrors, setAgentErrors] = useState<Record<string, string>>({});

  const draft = useComposerDraft({
    defaultIntent,
    onSubmit: async ({ body, intent }) => {
      // `submit` below no-ops before we get here when there is no target.
      await onAddAnnotation({ target: target as TTarget, body, intent });
      onClearSelection();
    },
  });
  const { body, setBody, intent, setIntent, error } = draft;

  const submit = async () => {
    if (!target) return;
    await draft.submit();
  };

  const resolve = async (annotationId: string) => {
    await onResolveAnnotation(annotationId);
  };

  const runAgent = async (annotationId: string) => {
    if (!onRunAgent) return;
    setRunningAgentIds((prev) => new Set(prev).add(annotationId));
    setAgentErrors((prev) => {
      const next = { ...prev };
      delete next[annotationId];
      return next;
    });
    try {
      const result = await onRunAgent(annotationId);
      if (!result.ok) {
        setAgentErrors((prev) => ({ ...prev, [annotationId]: result.detail }));
      }
    } catch (runError) {
      setAgentErrors((prev) => ({
        ...prev,
        [annotationId]: runError instanceof Error ? runError.message : "Failed to run agent.",
      }));
    } finally {
      setRunningAgentIds((prev) => {
        const next = new Set(prev);
        next.delete(annotationId);
        return next;
      });
    }
  };

  const undoPatch = async (annotationId: string, patchId: string, changedIds?: string[]) => {
    if (!onUndoPatch) return;
    setUndoingPatchIds((prev) => new Set(prev).add(annotationId));
    setAgentErrors((prev) => {
      const next = { ...prev };
      delete next[annotationId];
      return next;
    });
    try {
      const result = await onUndoPatch(patchId, changedIds);
      if (result.ok) {
        setUndonePatchIds((prev) => new Set(prev).add(annotationId));
      } else {
        setAgentErrors((prev) => ({ ...prev, [annotationId]: result.detail }));
      }
    } catch (undoError) {
      setAgentErrors((prev) => ({
        ...prev,
        [annotationId]: undoError instanceof Error ? undoError.message : "Failed to undo patch.",
      }));
    } finally {
      setUndoingPatchIds((prev) => {
        const next = new Set(prev);
        next.delete(annotationId);
        return next;
      });
    }
  };

  return {
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
  };
}
