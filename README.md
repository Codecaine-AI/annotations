# @codecaine-ai/annotations

Shared annotation primitives for Codecaine zones. An annotation marks a spot in a
document — a doc block, a prompt node, a dragged text range — and asks an agent
to act on it. Annotations are agent conversations, not passive comments: every
annotation carries an intent (the standard UX uses `agent-request` only), can
record the agent run that answered it, and can grow a reply thread.

The package is target-agnostic. Zones supply a *target adapter* describing what
their annotations point at; the engine supplies validation, dangling-target
detection, the panel UI, and the hover/drag targeting overlays. Two consumers
exist today:

- docs-system — `packages/docs-model/src/annotations-schema.ts`
  (`block`, `canvas-object`, `text-range`)
- prompt-kit — `src/annotations/schema.ts`
  (`prompt-node`, `prompt-range`, including document-anchored ranges)

## Entry points

| Import | Contents |
| --- | --- |
| `@codecaine-ai/annotations` | Re-exports `./core` |
| `@codecaine-ai/annotations/core` | Schema engine — no React |
| `@codecaine-ai/annotations/react` | Panel, hooks, targeting overlays, composer popover |

## Core

### The envelope

```ts
type Annotation<TTarget> = {
  id: string;
  target: TTarget;
  body: string;
  intent: string;        // instances restrict, e.g. "agent-request"
  author: string;
  status: string;        // instances restrict, e.g. "open" | "resolved"
  createdAt: string;
  agentRun?: AnnotationAgentRun;   // { sessionId, patchId, summary, changedIds? }
  resolution?: string;
  replies?: AnnotationReply[];     // { id, author, body, createdAt } — the thread
};

type AnnotationsDocument<TTarget> = { schemaVersion: 1; annotations: Annotation<TTarget>[] };
```

The shape never specializes per zone: an annotation on a sequence diagram looks
exactly like one on a paragraph. Zones differ only in `TTarget`.

### Target adapters

```ts
interface TargetAdapter<TTarget extends { kind: string }, TIndex = unknown> {
  kind: TTarget["kind"];
  /** Validate a raw target of this kind; push issues, return null when invalid. */
  validateTarget(raw: Record<string, unknown>, path: string, issues: ValidationIssue[]): TTarget | null;
  /** Stable grouping key. */
  key(target: TTarget): string;
  /** Human label. */
  label(target: TTarget): string;
  /**
   * Dangling check against zone state (`index`): null = resolves, a reason
   * string = dangling, "skip" = index not loaded yet, skip the check.
   */
  dangling(target: TTarget, index: TIndex): string | null | "skip";
}
```

### Schema instances

```ts
const schema = createAnnotationSchema<MyTarget>({
  adapters: [myAdapter],
  intents: ["agent-request"],
  statuses: ["open", "resolved"],
  // messages?: override unknown-kind / intent / status wording (defaults join
  // the configured lists with " or ", which is how docs-system keeps its
  // historical validation strings byte-identical).
});

schema.validateDocument(raw);                     // ValidationResult<MyTarget>
schema.detectDanglingTargets(doc, { [kind]: zoneIndex });
schema.targetKey(target);
schema.targetLabel(target);
```

Validation collects every issue (paths like `$.annotations[2].target.blockId`)
before failing; `replies`/`agentRun`/`resolution` are additive-optional so old
documents keep validating. Helpers `isRecord` and `isId` are exported for
adapters.

## React

### Panel + headless state

- `AnnotationPanel<TTarget>` — the sidebar list/thread view. Host supplies
  `annotations`, `targetKey`/`targetLabel`, precomputed `danglingReasons`, and
  callbacks (`onAddAnnotation`, `onResolveAnnotation`, optional `onFocusTarget`,
  `onRunAgent`, `onUndoPatch`, `onAddReply`). `showComposer={false}` renders the
  list only (the standard: composing happens in the anchored popover);
  `emptyState` overrides the empty copy; the intent picker auto-hides when a
  single `intentOptions` entry is configured. Reply threads render from
  `annotation.replies`; the reply affordance appears only when `onAddReply` is
  present.
- `useAnnotations` / `useComposerDraft` — the panel's state machine (composer
  draft, in-flight run/undo tracking, error capture) for zones building their
  own UI.

### Targeting overlays

- `useTargeting<TTarget>(options)` / `TargetingLayer<TTarget>` — hover a target,
  a dotted ring glides to it with a floating label chip; click reports the
  resolved target; drag reports a text range. Key options:
  - `resolveTarget(element)` → `{ elements, target, label } | null` — the zone's
    DOM→target mapping; the ring covers the union rect of `elements`.
  - `rangeModifier` — `"none"` (default) fires `onRangeSelect` on any selection;
    `"meta"` requires Cmd/Ctrl held at any point of the drag. While a modifier
    drag is live, a dotted drag ring tracks the selection and the native
    highlight is suppressed (`::selection` transparent + cleared after emit).
  - `resolveSelected`/`resolveToken` — the controlled pinned-target ring.
  - `suppressHover` — hosts set this while their composer popover is open.
  - Geometry re-measures on window/ancestor scrolls AND descendant scrollers
    (capture-phase listener — `scroll` does not bubble).
- `AnnotationComposerPopover` — the anchored composer: renders next to
  `anchorElements` (below, flips above), solid surface, `scopes` breadcrumb
  (leaf-first ancestor chain; host re-anchors on `onScopeChange`), single-intent
  by default with the "Annotate" submit.
- `measureUnionRect(elements, container)` — the shared geometry helper.

### The standard annotate-mode UX

One page of rules every zone follows:

1. Annotate mode only annotates — editor affordances hidden, no native text
   highlight, dotted rings are the only selection feedback.
2. Hover targets the deepest unit; click pins it and opens the popover composer
   anchored at the target.
3. Cmd/Ctrl+drag selects a swath as a range target, ring tracking live; the
   bounded swath is exactly what gets annotated.
4. Every annotation is an agent request; the sidebar is the thread list.

## Styling: self-contained by design

All load-bearing visuals (rings, chip, popover, drag ring) ship in an injected
stylesheet (`TARGETING_CSS`) keyed off `data-annotation-*` attributes — Tailwind
classes on these elements are progressive enhancement only. This is a hard
lesson: a host's Tailwind build never scans this package, and a vite host that
prebundles it serves a frozen copy that ignores every fix (see
`../DEVELOPMENT.md`, "Why This Exists"). Never move critical styling onto
utility classes.

Hosts theme via CSS custom properties (any ancestor):

| Token | Fallback (light / dark) | Styles |
| --- | --- | --- |
| `--annotation-accent` | `#6366f1` | ring borders, primary button, active chips |
| `--annotation-surface` | `#ffffff` / `#1c1c20` | popover + chip background |
| `--annotation-text` | `#18181b` / `#e4e4e7` | popover + chip text |
| `--annotation-muted` | `#71717a` / `#a1a1aa` | secondary text, ghost buttons |
| `--annotation-border` | `rgba(0,0,0,.15)` / `rgba(255,255,255,.14)` | borders |
| `--annotation-danger` | `#dc2626` / `#f87171` | inline errors |

DOM contract (for hosts and tests): `data-annotation-targeting` on the
container; `data-annotation-ring` / `-ring-selected` / `-chip` / `-composer` /
`-composer-placement` / `-scopes` / `-scope` on overlays; everything the
package renders carries `data-annotation-ui` and is skip-listed from targeting
(`DEFAULT_SKIP_SELECTOR`).

## Writing a zone adapter

1. Define the target union with stable ids from your zone's state files
   (`{ kind: "prompt-node", docId, nodeId }`-shaped: always carry the containing
   resource id, not only the leaf).
2. Implement `TargetAdapter` per kind; `dangling` returns `"skip"` while your
   index is still loading so annotations never flash "removed" during load.
3. Build a schema instance and wire `useTargeting` + `AnnotationComposerPopover`
   + `AnnotationPanel` with your `resolveTarget`. Persistence stays yours —
   the package never talks to a server.

Both existing consumers are the best reference; prompt-kit's `prompt-range`
additionally shows entity-aware DOM→model offset mapping when the display
decodes what the model stores.

## Development

This package is a member of the Core bun meta-workspace — install from
`Core/` (`bun install`), see `../DEVELOPMENT.md`. Tests: `bun test` (happy-dom
for the React suites).
