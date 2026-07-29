import assert from "node:assert/strict";
import test from "node:test";
import type { CodexStoredSessionRecord } from "./codex-stored-session-types";
import {
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
});
