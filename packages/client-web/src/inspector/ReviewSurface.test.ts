import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildReviewDiffRequest,
  normalizeReviewFiles,
  reviewScopeContentIdentity,
  type ReviewScope,
} from "./review-contract";

describe("ReviewSurface scope contract", () => {
  test("normalizes a frozen turn snapshot without workspace staging state", () => {
    const scope: ReviewScope = {
      kind: "turn",
      sessionId: "session-1",
      turnId: "turn-7",
      workspaceRoot: "/workspace",
      files: [
        {
          path: "src/main.ts",
          additions: 12,
          deletions: 3,
        },
      ],
      totalAdditions: 12,
      totalDeletions: 3,
      truncated: false,
    };

    assert.deepEqual(normalizeReviewFiles(scope), [
      {
        key: "turn:src/main.ts",
        path: "src/main.ts",
        additions: 12,
        deletions: 3,
        staged: null,
        binary: false,
      },
    ]);
  });

  test("keeps staged and unstaged workspace entries distinct", () => {
    const scope: ReviewScope = {
      kind: "workspace",
      sessionId: "session-1",
      workspaceRoot: "/workspace",
      files: [
        {
          path: "src/main.ts",
          status: "modified",
          staged: true,
          added: 4,
          removed: 1,
        },
        {
          path: "src/main.ts",
          status: "modified",
          staged: false,
          added: 2,
          removed: 3,
        },
      ],
    };

    assert.deepEqual(
      normalizeReviewFiles(scope).map((file) => file.key),
      [
        "workspace:staged:src/main.ts",
        "workspace:unstaged:src/main.ts",
      ],
    );
  });

  test("routes turn reviews only through the frozen turn artifact API", () => {
    const scope: ReviewScope = {
      kind: "turn",
      sessionId: "session-1",
      turnId: "turn-7",
      workspaceRoot: "/workspace",
      files: [
        {
          path: "src/main.ts",
          additions: 12,
          deletions: 3,
        },
      ],
      totalAdditions: 12,
      totalDeletions: 3,
      truncated: false,
    };
    const file = normalizeReviewFiles(scope)[0]!;

    assert.deepEqual(buildReviewDiffRequest(scope, file, true), {
      kind: "turn",
      sessionId: "session-1",
      turnId: "turn-7",
      path: "src/main.ts",
    });
  });

  test("routes a live session workspace through its session-scoped Git API", () => {
    const scope: ReviewScope = {
      kind: "workspace",
      sessionId: "session-1",
      workspaceRoot: "/workspace",
      files: [
        {
          path: "src/main.ts",
          status: "modified",
          staged: false,
          added: 2,
          removed: 3,
        },
      ],
    };
    const file = normalizeReviewFiles(scope)[0]!;

    assert.deepEqual(buildReviewDiffRequest(scope, file, true), {
      kind: "session-workspace",
      sessionId: "session-1",
      path: "src/main.ts",
      staged: false,
      ignoreWhitespace: true,
      scopeRoot: "/workspace",
    });
  });

  test("routes a standalone workspace through the directory-scoped Git API", () => {
    const scope: ReviewScope = {
      kind: "workspace",
      sessionId: null,
      workspaceRoot: "/workspace",
      files: [
        {
          path: "README.md",
          status: "modified",
          staged: true,
          added: 1,
          removed: 0,
        },
      ],
    };
    const file = normalizeReviewFiles(scope)[0]!;

    assert.deepEqual(buildReviewDiffRequest(scope, file, false), {
      kind: "workspace",
      workspaceRoot: "/workspace",
      path: "README.md",
      staged: true,
      ignoreWhitespace: false,
    });
  });

  test("gives equivalent scope objects the same semantic content identity", () => {
    const scope: ReviewScope = {
      kind: "workspace",
      sessionId: "session-1",
      workspaceRoot: "/workspace",
      files: [
        {
          path: "src/main.ts",
          status: "modified",
          staged: false,
          added: 2,
          removed: 3,
        },
      ],
    };
    const clone = structuredClone(scope);

    assert.notEqual(clone, scope);
    assert.equal(
      reviewScopeContentIdentity(clone),
      reviewScopeContentIdentity(scope),
    );
  });

  test("changes semantic content identity when review metadata changes", () => {
    const original: ReviewScope = {
      kind: "turn",
      sessionId: "session-1",
      turnId: "turn-7",
      workspaceRoot: "/workspace",
      files: [
        {
          path: "src/main.ts",
          additions: 12,
          deletions: 3,
        },
      ],
      totalAdditions: 12,
      totalDeletions: 3,
      truncated: false,
    };
    const updated: ReviewScope = {
      ...original,
      files: [
        {
          path: "src/main.ts",
          additions: 13,
          deletions: 3,
        },
      ],
      totalAdditions: 13,
    };

    assert.notEqual(
      reviewScopeContentIdentity(updated),
      reviewScopeContentIdentity(original),
    );
  });
});
