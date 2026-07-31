"use client";

/**
 * React entry — the generic annotation panel UI and its headless state hook.
 * Kept separate from `./core` so non-React consumers never pull in React.
 */

export {
  AnnotationPanel,
  type AnnotationPanelProps,
  type AnnotationPanelIntentOption,
} from "./AnnotationPanel";
export {
  useAnnotations,
  useComposerDraft,
  type UseAnnotationsOptions,
  type UseAnnotationsResult,
  type UseComposerDraftOptions,
  type UseComposerDraftResult,
  type AddAnnotationInput,
  type RunAgentResult,
  type UndoPatchResult,
} from "./useAnnotations";
export {
  useTargeting,
  TargetingLayer,
  AnnotationComposerPopover,
  measureUnionRect,
  DEFAULT_SKIP_SELECTOR,
  TARGETING_CSS,
  type AnnotationComposerPopoverProps,
  type AnnotationComposerScope,
  type OverlayRect,
  type RangeModifier,
  type ResolvedTarget,
  type Targeting,
  type TargetingContainerProps,
  type TargetingLayerProps,
  type TargetingOptions,
} from "./targeting/index";
