import assert from "node:assert/strict";
import test from "node:test";
import type { CodexStoredSessionRecord } from "./codex-stored-session-types";
import { codexVisualArtifactIdForPath } from "./codex-visual-artifacts";
import {
  resolveCodexVisualArtifactCandidates,
  resolveCodexVisualArtifactPath,
  resolveCodexVisualArtifactRoot,
} from "./codex-visual-artifact-path";

function record(
  rolloutPath: string,
  providerSessionId = "019f7d82-3eaa-7093-8d75-27a51b60e2cf",
): CodexStoredSessionRecord {
  return {
    ref: { provider: "codex", providerSessionId },
    rolloutPath,
    archived: false,
  };
}

test("resolves active rollout visuals from the rollout date and storage home", () => {
  const stored = record(
    "/Users/test/.codex/sessions/2026/07/20/rollout-2026-07-20T10-11-12-019f7d82-3eaa-7093-8d75-27a51b60e2cf.jsonl",
  );

  assert.equal(
    resolveCodexVisualArtifactRoot(stored),
    "/Users/test/.codex/visualizations",
  );
  assert.equal(
    resolveCodexVisualArtifactPath(stored, "equity-curve.html"),
    "/Users/test/.codex/visualizations/2026/07/20/019f7d82-3eaa-7093-8d75-27a51b60e2cf/equity-curve.html",
  );
});

test("resolves archived rollout visuals from the date encoded in the filename", () => {
  const stored = record(
    "/Users/test/.codex/archived_sessions/rollout-2026-06-09T10-11-12-019f7d82-3eaa-7093-8d75-27a51b60e2cf.jsonl",
  );

  assert.equal(
    resolveCodexVisualArtifactPath(stored, "curve.html"),
    "/Users/test/.codex/visualizations/2026/06/09/019f7d82-3eaa-7093-8d75-27a51b60e2cf/curve.html",
  );
});

test("prefers the exact workspace visualization path and retains provider storage fallback", () => {
  const stored = record(
    "/Users/test/.codex/sessions/2026/07/20/rollout.jsonl",
  );
  stored.ref.cwd = "/Volumes/Data/skew";

  assert.deepEqual(
    resolveCodexVisualArtifactCandidates(stored, "curve.html"),
    [
      {
        securityRootPath: "/Volumes/Data/skew",
        artifactPath:
          "/Volumes/Data/skew/.codex/visualizations/2026/07/20/019f7d82-3eaa-7093-8d75-27a51b60e2cf/curve.html",
      },
      {
        securityRootPath: "/Users/test/.codex/visualizations",
        artifactPath:
          "/Users/test/.codex/visualizations/2026/07/20/019f7d82-3eaa-7093-8d75-27a51b60e2cf/curve.html",
      },
    ],
  );
});

test("rejects unsafe artifact ids and unsafe provider session ids", () => {
  const stored = record(
    "/Users/test/.codex/sessions/2026/07/20/rollout.jsonl",
  );
  assert.equal(resolveCodexVisualArtifactPath(stored, "../curve.html"), undefined);
  assert.equal(
    resolveCodexVisualArtifactPath(
      record(
        "/Users/test/.codex/sessions/2026/07/20/rollout.jsonl",
        "../session",
      ),
      "curve.html",
    ),
    undefined,
  );
  assert.deepEqual(resolveCodexVisualArtifactCandidates(stored, "../curve.html"), []);
});

test("resolves provider-evidenced visualization paths without guessing the session directory", () => {
  const stored = record(
    "/Users/test/.codex/sessions/2026/08/15/rollout.jsonl",
  );
  stored.ref.cwd = "/Volumes/Data/skew";
  const artifactId = codexVisualArtifactIdForPath(
    ".codex/visualizations/2026/08/15/sxx-optimal-combinations/optimal-candidate-combinations.html",
  )!;

  assert.deepEqual(resolveCodexVisualArtifactCandidates(stored, artifactId), [
    {
      securityRootPath: "/Volumes/Data/skew/.codex/visualizations",
      artifactPath:
        "/Volumes/Data/skew/.codex/visualizations/2026/08/15/sxx-optimal-combinations/optimal-candidate-combinations.html",
    },
  ]);
});
