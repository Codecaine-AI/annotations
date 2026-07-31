"use client";

/**
 * Default composition for `useTargeting`: a `position: relative` container
 * wrapping the host's rendered surface, with the hover ring, label chip and
 * selected ring rendered inside it. Hosts needing custom composition use the
 * hook directly (mirrors docs-system's DocTargetingLayer/useDocTargeting pair).
 */

import type { ReactNode } from "react";
import { cn } from "../ui/cn";
import { useTargeting, type TargetingOptions } from "./useTargeting";

export interface TargetingLayerProps<TTarget> extends TargetingOptions<TTarget> {
  /** Extra classes for the container (already `position: relative`). */
  className?: string;
  children: ReactNode;
}

export function TargetingLayer<TTarget>({
  className,
  children,
  ...options
}: TargetingLayerProps<TTarget>) {
  const targeting = useTargeting(options);

  return (
    <div
      ref={targeting.containerRef}
      {...targeting.containerProps}
      className={cn("relative", className)}
    >
      {children}
      {targeting.overlays}
    </div>
  );
}
