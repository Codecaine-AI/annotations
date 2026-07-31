/**
 * Generic annotation engine — an annotation marks a spot in some host
 * document (a block, a canvas object, a line of code, …) and carries a
 * request or note; agents process them. The engine is target-agnostic:
 * host packages plug in `TargetAdapter`s that know how to validate a
 * target shape, key/label it, and decide whether it still resolves.
 *
 * Instances restrict `intent`/`status` to their own closed sets via
 * `createAnnotationSchema` config; the engine-level types keep them as
 * plain strings so hosts can narrow them.
 */

export type AnnotationIntent = string;
export type AnnotationStatus = string;

// `changedIds` is optional/additive so documents written by older code (no
// `changedIds`) still validate — it lists the target ids the agent run
// actually touched, letting a UI flash/highlight exactly those targets.
export type AnnotationAgentRun = {
  sessionId: string;
  patchId: string;
  summary: string;
  changedIds?: string[];
};

/**
 * A single reply in an annotation's thread — every annotation is a
 * conversation with an agent, not a one-shot comment. Optional/additive like
 * `changedIds` so documents written by older code (no `replies`) still
 * validate byte-identically.
 */
export type AnnotationReply = {
  id: string;
  author: string;
  body: string;
  createdAt: string;
};

export type Annotation<TTarget> = {
  id: string;
  target: TTarget;
  body: string;
  intent: string;
  author: string;
  status: string;
  createdAt: string;
  agentRun?: AnnotationAgentRun;
  /**
   * Optional resolution note persisted when the annotation is resolved with
   * a response. Optional/additive like `changedIds` so older documents
   * still validate.
   */
  resolution?: string;
  /** Optional conversation thread under this annotation. Optional/additive. */
  replies?: AnnotationReply[];
};

export type AnnotationsDocument<TTarget> = {
  schemaVersion: 1;
  annotations: Annotation<TTarget>[];
};

export type ValidationIssue = { path: string; message: string };
export type ValidationResult<TTarget> =
  | { ok: true; document: AnnotationsDocument<TTarget> }
  | { ok: false; issues: ValidationIssue[] };

export type DanglingTarget = { annotationId: string; reason: string };

export interface TargetAdapter<TTarget extends { kind: string }, TIndex = unknown> {
  kind: TTarget["kind"];
  /**
   * Validate a raw target of this kind. Push issues to `issues` using `path`
   * as the prefix; return null when invalid.
   */
  validateTarget(
    raw: Record<string, unknown>,
    path: string,
    issues: ValidationIssue[],
  ): TTarget | null;
  /** Stable grouping key. */
  key(target: TTarget): string;
  /** Human label. */
  label(target: TTarget): string;
  /**
   * Dangling check. `index` is zone state (e.g. the doc, or canvas id sets).
   * Return:
   *  - null when the target resolves fine,
   *  - a human-readable reason string when it is dangling,
   *  - "skip" when the index is not loaded yet and the check must be skipped.
   */
  dangling(target: TTarget, index: TIndex): string | null | "skip";
}

export type AnnotationSchemaConfig = {
  adapters: ReadonlyArray<TargetAdapter<any, any>>;
  /** Closed set of accepted intents, e.g. ["note", "agent-request"]. */
  intents: readonly string[];
  /** Closed set of accepted statuses, e.g. ["open", "resolved"]. */
  statuses: readonly string[];
  /**
   * Optional overrides for the generated issue messages. The defaults join
   * the configured lists with " or " (e.g. "Annotation intent must be note
   * or agent-request."), which hosts can override when their wording
   * differs.
   */
  messages?: {
    unknownTargetKind?: string;
    invalidIntent?: string;
    invalidStatus?: string;
  };
};

export type AnnotationSchema<TTarget extends { kind: string }> = {
  validateDocument(value: unknown): ValidationResult<TTarget>;
  /**
   * Flags annotations whose targets no longer resolve. `indexes` maps target
   * kind → that adapter's index (zone state); an adapter may answer "skip"
   * when its index is not loaded yet, which suppresses the check entirely.
   */
  detectDanglingTargets(
    doc: AnnotationsDocument<TTarget>,
    indexes: Record<string, unknown>,
  ): DanglingTarget[];
  targetKey(target: TTarget): string;
  targetLabel(target: TTarget): string;
};

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,96}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function createAnnotationSchema<TTarget extends { kind: string }>(
  config: AnnotationSchemaConfig,
): AnnotationSchema<TTarget> {
  const { adapters, intents, statuses, messages } = config;

  const adaptersByKind = new Map<string, TargetAdapter<any, any>>();
  for (const adapter of adapters) adaptersByKind.set(adapter.kind, adapter);

  const unknownTargetKindMessage =
    messages?.unknownTargetKind ??
    `Annotation target kind must be ${adapters.map((adapter) => adapter.kind).join(" or ")}.`;
  const invalidIntentMessage =
    messages?.invalidIntent ?? `Annotation intent must be ${intents.join(" or ")}.`;
  const invalidStatusMessage =
    messages?.invalidStatus ?? `Annotation status must be ${statuses.join(" or ")}.`;

  const isIntent = (value: unknown): value is string =>
    typeof value === "string" && intents.includes(value);
  const isStatus = (value: unknown): value is string =>
    typeof value === "string" && statuses.includes(value);

  function requireAdapter(kind: string): TargetAdapter<any, any> {
    const adapter = adaptersByKind.get(kind);
    if (!adapter) throw new Error(`No annotation target adapter for kind "${kind}".`);
    return adapter;
  }

  function validateTarget(
    value: unknown,
    path: string,
    issues: ValidationIssue[],
  ): TTarget | null {
    if (!isRecord(value)) {
      issues.push({ path, message: "Annotation target must be an object." });
      return null;
    }
    const adapter =
      typeof value.kind === "string" ? adaptersByKind.get(value.kind) : undefined;
    if (!adapter) {
      issues.push({ path: `${path}.kind`, message: unknownTargetKindMessage });
      return null;
    }
    return adapter.validateTarget(value, path, issues) as TTarget | null;
  }

  function validateDocument(value: unknown): ValidationResult<TTarget> {
    const issues: ValidationIssue[] = [];
    if (!isRecord(value)) {
      return { ok: false, issues: [{ path: "$", message: "Annotations document must be an object." }] };
    }
    if (value.schemaVersion !== 1) {
      issues.push({ path: "$.schemaVersion", message: "Annotations schemaVersion must be 1." });
    }

    if (!Array.isArray(value.annotations)) {
      issues.push({ path: "$.annotations", message: "Annotations must be an array." });
      return { ok: false, issues };
    }
    const rawAnnotations = value.annotations;

    const seenIds = new Set<string>();
    const annotations: Annotation<TTarget>[] = [];
    for (const [index, rawAnnotation] of rawAnnotations.entries()) {
      const path = `$.annotations[${index}]`;
      if (!isRecord(rawAnnotation)) {
        issues.push({ path, message: "Annotation must be an object." });
        continue;
      }

      if (!isId(rawAnnotation.id)) {
        issues.push({ path: `${path}.id`, message: "Annotation requires a valid id." });
      } else if (seenIds.has(rawAnnotation.id)) {
        issues.push({ path: `${path}.id`, message: `Duplicate annotation id "${rawAnnotation.id}".` });
      } else {
        seenIds.add(rawAnnotation.id);
      }

      const target = validateTarget(rawAnnotation.target, `${path}.target`, issues);

      if (typeof rawAnnotation.body !== "string") {
        issues.push({ path: `${path}.body`, message: "Annotation body must be a string." });
      }
      if (!isIntent(rawAnnotation.intent)) {
        issues.push({ path: `${path}.intent`, message: invalidIntentMessage });
      }
      if (typeof rawAnnotation.author !== "string" || rawAnnotation.author.length === 0) {
        issues.push({ path: `${path}.author`, message: "Annotation author must be a non-empty string." });
      }
      if (!isStatus(rawAnnotation.status)) {
        issues.push({ path: `${path}.status`, message: invalidStatusMessage });
      }
      if (typeof rawAnnotation.createdAt !== "string") {
        issues.push({ path: `${path}.createdAt`, message: "Annotation createdAt must be a string." });
      }

      let agentRun: AnnotationAgentRun | undefined;
      if (rawAnnotation.agentRun !== undefined) {
        if (!isRecord(rawAnnotation.agentRun)) {
          issues.push({ path: `${path}.agentRun`, message: "Annotation agentRun must be an object." });
        } else {
          const rawAgentRun = rawAnnotation.agentRun;
          if (typeof rawAgentRun.sessionId !== "string") {
            issues.push({ path: `${path}.agentRun.sessionId`, message: "Annotation agentRun sessionId must be a string." });
          }
          if (typeof rawAgentRun.patchId !== "string") {
            issues.push({ path: `${path}.agentRun.patchId`, message: "Annotation agentRun patchId must be a string." });
          }
          if (typeof rawAgentRun.summary !== "string") {
            issues.push({ path: `${path}.agentRun.summary`, message: "Annotation agentRun summary must be a string." });
          }
          let changedIds: string[] | undefined;
          let changedIdsValid = true;
          if (rawAgentRun.changedIds !== undefined) {
            if (!Array.isArray(rawAgentRun.changedIds) || !rawAgentRun.changedIds.every((v) => typeof v === "string")) {
              changedIdsValid = false;
              issues.push({
                path: `${path}.agentRun.changedIds`,
                message: "Annotation agentRun changedIds must be an array of strings.",
              });
            } else {
              changedIds = rawAgentRun.changedIds;
            }
          }
          if (
            typeof rawAgentRun.sessionId === "string" &&
            typeof rawAgentRun.patchId === "string" &&
            typeof rawAgentRun.summary === "string" &&
            changedIdsValid
          ) {
            agentRun = {
              sessionId: rawAgentRun.sessionId,
              patchId: rawAgentRun.patchId,
              summary: rawAgentRun.summary,
              ...(changedIds ? { changedIds } : {}),
            };
          }
        }
      }

      let replies: AnnotationReply[] | undefined;
      let repliesValid = true;
      if (rawAnnotation.replies !== undefined) {
        if (!Array.isArray(rawAnnotation.replies)) {
          repliesValid = false;
          issues.push({
            path: `${path}.replies`,
            message: "Annotation replies must be an array.",
          });
        } else {
          const collected: AnnotationReply[] = [];
          for (const [replyIndex, rawReply] of rawAnnotation.replies.entries()) {
            const replyPath = `${path}.replies[${replyIndex}]`;
            if (!isRecord(rawReply)) {
              repliesValid = false;
              issues.push({ path: replyPath, message: "Annotation reply must be an object." });
              continue;
            }
            if (!isId(rawReply.id)) {
              repliesValid = false;
              issues.push({ path: `${replyPath}.id`, message: "Annotation reply requires a valid id." });
            }
            if (typeof rawReply.author !== "string" || rawReply.author.length === 0) {
              repliesValid = false;
              issues.push({
                path: `${replyPath}.author`,
                message: "Annotation reply author must be a non-empty string.",
              });
            }
            if (typeof rawReply.body !== "string") {
              repliesValid = false;
              issues.push({ path: `${replyPath}.body`, message: "Annotation reply body must be a string." });
            }
            if (typeof rawReply.createdAt !== "string") {
              repliesValid = false;
              issues.push({
                path: `${replyPath}.createdAt`,
                message: "Annotation reply createdAt must be a string.",
              });
            }
            if (
              isId(rawReply.id) &&
              typeof rawReply.author === "string" &&
              rawReply.author.length > 0 &&
              typeof rawReply.body === "string" &&
              typeof rawReply.createdAt === "string"
            ) {
              collected.push({
                id: rawReply.id,
                author: rawReply.author,
                body: rawReply.body,
                createdAt: rawReply.createdAt,
              });
            }
          }
          if (repliesValid) replies = collected;
        }
      }

      let resolutionValid = true;
      if (rawAnnotation.resolution !== undefined && typeof rawAnnotation.resolution !== "string") {
        resolutionValid = false;
        issues.push({
          path: `${path}.resolution`,
          message: "Annotation resolution must be a string when present.",
        });
      }

      if (
        isId(rawAnnotation.id) &&
        target &&
        typeof rawAnnotation.body === "string" &&
        isIntent(rawAnnotation.intent) &&
        typeof rawAnnotation.author === "string" &&
        rawAnnotation.author.length > 0 &&
        isStatus(rawAnnotation.status) &&
        typeof rawAnnotation.createdAt === "string" &&
        (rawAnnotation.agentRun === undefined || agentRun) &&
        resolutionValid &&
        repliesValid
      ) {
        annotations.push({
          id: rawAnnotation.id,
          target,
          body: rawAnnotation.body,
          intent: rawAnnotation.intent,
          author: rawAnnotation.author,
          status: rawAnnotation.status,
          createdAt: rawAnnotation.createdAt,
          ...(agentRun ? { agentRun } : {}),
          ...(typeof rawAnnotation.resolution === "string" ? { resolution: rawAnnotation.resolution } : {}),
          ...(replies ? { replies } : {}),
        });
      }
    }

    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, document: { schemaVersion: 1, annotations } };
  }

  function detectDanglingTargets(
    doc: AnnotationsDocument<TTarget>,
    indexes: Record<string, unknown>,
  ): DanglingTarget[] {
    const dangling: DanglingTarget[] = [];
    for (const annotation of doc.annotations) {
      const adapter = adaptersByKind.get(annotation.target.kind);
      if (!adapter) continue;
      const result = adapter.dangling(annotation.target, indexes[annotation.target.kind]);
      if (result === "skip" || result === null) continue;
      dangling.push({ annotationId: annotation.id, reason: result });
    }
    return dangling;
  }

  return {
    validateDocument,
    detectDanglingTargets,
    targetKey: (target) => requireAdapter(target.kind).key(target),
    targetLabel: (target) => requireAdapter(target.kind).label(target),
  };
}
