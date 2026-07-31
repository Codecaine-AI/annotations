import { describe, expect, it } from "bun:test";

import {
  createAnnotationSchema,
  isId,
  type TargetAdapter,
  type ValidationIssue,
} from "../core";

type LineTarget = { kind: "line"; file: string; line: number };
type CellTarget = { kind: "cell"; cellId: string };
type TestTarget = LineTarget | CellTarget;

/** Index: set of known files, or null when not loaded yet. */
const lineAdapter: TargetAdapter<LineTarget, ReadonlySet<string> | null | undefined> = {
  kind: "line",
  validateTarget(raw, path, issues: ValidationIssue[]) {
    if (typeof raw.file !== "string" || raw.file.length === 0) {
      issues.push({ path: `${path}.file`, message: "Line target requires a non-empty file." });
      return null;
    }
    if (typeof raw.line !== "number" || !Number.isInteger(raw.line) || raw.line < 1) {
      issues.push({ path: `${path}.line`, message: "Line target requires a positive integer line." });
      return null;
    }
    return { kind: "line", file: raw.file, line: raw.line };
  },
  key: (target) => `line:${target.file}:${target.line}`,
  label: (target) => `${target.file}:${target.line}`,
  dangling(target, files) {
    if (!files) return "skip";
    return files.has(target.file) ? null : `File "${target.file}" no longer exists.`;
  },
};

const cellAdapter: TargetAdapter<CellTarget, ReadonlySet<string>> = {
  kind: "cell",
  validateTarget(raw, path, issues: ValidationIssue[]) {
    if (!isId(raw.cellId)) {
      issues.push({ path: `${path}.cellId`, message: "Cell target requires a valid cellId." });
      return null;
    }
    return { kind: "cell", cellId: raw.cellId };
  },
  key: (target) => `cell:${target.cellId}`,
  label: (target) => `Cell ${target.cellId}`,
  dangling(target, cells) {
    return cells.has(target.cellId) ? null : `Cell "${target.cellId}" no longer exists.`;
  },
};

const schema = createAnnotationSchema<TestTarget>({
  adapters: [lineAdapter, cellAdapter],
  intents: ["note", "agent-request"],
  statuses: ["open", "resolved"],
});

function annotation(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "a1",
    target: { kind: "line", file: "main.ts", line: 3 },
    body: "Note",
    intent: "note",
    author: "Ford",
    status: "open",
    createdAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("createAnnotationSchema — validateDocument", () => {
  it("accepts a valid document across adapter kinds", () => {
    const value = {
      schemaVersion: 1,
      annotations: [
        annotation({}),
        annotation({
          id: "a2",
          target: { kind: "cell", cellId: "c9" },
          intent: "agent-request",
          status: "resolved",
          agentRun: { sessionId: "s1", patchId: "p1", summary: "Did it", changedIds: ["c9"] },
          resolution: "Handled",
        }),
      ],
    };

    const result = schema.validateDocument(value);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.annotations).toEqual(value.annotations as never);
    }
  });

  it("rejects an unknown target kind with the joined-kind message", () => {
    const result = schema.validateDocument({
      schemaVersion: 1,
      annotations: [annotation({ target: { kind: "orbit", file: "x" } })],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        path: "$.annotations[0].target.kind",
        message: "Annotation target kind must be line or cell.",
      });
    }
  });

  it("rejects duplicate ids", () => {
    const result = schema.validateDocument({
      schemaVersion: 1,
      annotations: [annotation({}), annotation({ body: "Again" })],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        path: "$.annotations[1].id",
        message: 'Duplicate annotation id "a1".',
      });
    }
  });

  it("enforces the configured intents and statuses with joined messages", () => {
    const result = schema.validateDocument({
      schemaVersion: 1,
      annotations: [annotation({ intent: "todo", status: "stale" })],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        path: "$.annotations[0].intent",
        message: "Annotation intent must be note or agent-request.",
      });
      expect(result.issues).toContainEqual({
        path: "$.annotations[0].status",
        message: "Annotation status must be open or resolved.",
      });
    }

    const widened = createAnnotationSchema<TestTarget>({
      adapters: [lineAdapter, cellAdapter],
      intents: ["note", "agent-request", "todo"],
      statuses: ["open", "resolved", "stale"],
    });
    expect(widened.validateDocument({
      schemaVersion: 1,
      annotations: [annotation({ intent: "todo", status: "stale" })],
    }).ok).toBe(true);
  });

  it("supports message overrides", () => {
    const custom = createAnnotationSchema<TestTarget>({
      adapters: [lineAdapter],
      intents: ["note"],
      statuses: ["open"],
      messages: { unknownTargetKind: "Nope." },
    });
    const result = custom.validateDocument({
      schemaVersion: 1,
      annotations: [annotation({ target: { kind: "cell", cellId: "c1" } })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({ path: "$.annotations[0].target.kind", message: "Nope." });
    }
  });

  it("collects adapter target issues and rejects malformed documents", () => {
    const result = schema.validateDocument({
      schemaVersion: 2,
      annotations: [annotation({ target: { kind: "line", file: "", line: 0 } })],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.issues.map((issue) => issue.path);
      expect(paths).toContain("$.schemaVersion");
      expect(paths).toContain("$.annotations[0].target.file");
    }
  });
});

describe("createAnnotationSchema — replies", () => {
  const reply = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "r1",
    author: "agent",
    body: "Done — tightened the section.",
    createdAt: "2026-07-30T01:00:00.000Z",
    ...overrides,
  });

  it("accepts annotations with valid replies and preserves them", () => {
    const value = {
      schemaVersion: 1,
      annotations: [
        annotation({
          replies: [reply(), reply({ id: "r2", author: "Ford", body: "Thanks, looks right." })],
        }),
      ],
    };

    const result = schema.validateDocument(value);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.annotations[0].replies).toEqual([
        {
          id: "r1",
          author: "agent",
          body: "Done — tightened the section.",
          createdAt: "2026-07-30T01:00:00.000Z",
        },
        {
          id: "r2",
          author: "Ford",
          body: "Thanks, looks right.",
          createdAt: "2026-07-30T01:00:00.000Z",
        },
      ]);
    }
  });

  it("rejects a non-array replies value", () => {
    const result = schema.validateDocument({
      schemaVersion: 1,
      annotations: [annotation({ replies: "nope" })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        path: "$.annotations[0].replies",
        message: "Annotation replies must be an array.",
      });
    }
  });

  it("validates each reply field with $.annotations[i].replies[j] paths", () => {
    const result = schema.validateDocument({
      schemaVersion: 1,
      annotations: [
        annotation({
          replies: [reply(), { id: "??", author: "", body: 1, createdAt: 2 }],
        }),
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.issues.map((issue) => issue.path);
      expect(paths).toContain("$.annotations[0].replies[1].id");
      expect(paths).toContain("$.annotations[0].replies[1].author");
      expect(paths).toContain("$.annotations[0].replies[1].body");
      expect(paths).toContain("$.annotations[0].replies[1].createdAt");
      // The valid sibling reply produced no issues.
      expect(paths.some((path) => path.startsWith("$.annotations[0].replies[0]"))).toBe(false);
    }
  });

  it("rejects non-object replies entries", () => {
    const result = schema.validateDocument({
      schemaVersion: 1,
      annotations: [annotation({ replies: ["hello"] })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        path: "$.annotations[0].replies[0]",
        message: "Annotation reply must be an object.",
      });
    }
  });

  it("stays additive — documents without replies validate without a replies key", () => {
    const result = schema.validateDocument({
      schemaVersion: 1,
      annotations: [annotation({})],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("replies" in result.document.annotations[0]).toBe(false);
      expect(result.document.annotations[0]).toEqual(annotation({}) as never);
    }
  });
});

describe("createAnnotationSchema — detectDanglingTargets", () => {
  const doc = {
    schemaVersion: 1 as const,
    annotations: [
      {
        id: "gone-line",
        target: { kind: "line" as const, file: "deleted.ts", line: 1 },
        body: "",
        intent: "note",
        author: "Ford",
        status: "open",
        createdAt: "2026-07-30T00:00:00.000Z",
      },
      {
        id: "ok-cell",
        target: { kind: "cell" as const, cellId: "c1" },
        body: "",
        intent: "note",
        author: "Ford",
        status: "open",
        createdAt: "2026-07-30T00:00:01.000Z",
      },
    ],
  };

  it("reports a reason per dangling target", () => {
    const dangling = schema.detectDanglingTargets(doc, {
      line: new Set(["main.ts"]),
      cell: new Set(["c1"]),
    });
    expect(dangling).toEqual([
      { annotationId: "gone-line", reason: 'File "deleted.ts" no longer exists.' },
    ]);
  });

  it("skips checks when the adapter answers \"skip\" for an unloaded index", () => {
    const dangling = schema.detectDanglingTargets(doc, {
      line: null,
      cell: new Set<string>(),
    });
    expect(dangling).toEqual([
      { annotationId: "ok-cell", reason: 'Cell "c1" no longer exists.' },
    ]);
  });
});

describe("createAnnotationSchema — targetKey/targetLabel", () => {
  it("dispatches to the adapter by kind", () => {
    expect(schema.targetKey({ kind: "line", file: "main.ts", line: 3 })).toBe("line:main.ts:3");
    expect(schema.targetLabel({ kind: "cell", cellId: "c1" })).toBe("Cell c1");
  });
});
