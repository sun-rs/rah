import assert from "node:assert/strict";
import { test } from "node:test";
import type { ListSessionsResponse } from "@rah/runtime-protocol";
import { resolveHistorySelectionRestoreTarget } from "./session-store-bootstrap";

function response(
  sessions: ListSessionsResponse["sessions"] = [],
  recentSessions: ListSessionsResponse["recentSessions"] = [],
  storedSessions: ListSessionsResponse["storedSessions"] = [],
): ListSessionsResponse {
  return {
    sessions,
    recentSessions,
    storedSessions,
    workspaceDirs: [],
  };
}

test("page refresh restores the exact running provider session", () => {
  const target = resolveHistorySelectionRestoreTarget(
    {
      provider: "codex",
      providerSessionId: "provider-session-1",
      workspaceDir: "/remembered/workspace",
    },
    response([
      {
        session: {
          id: "runtime-1",
          provider: "codex",
          providerSessionId: "provider-session-1",
          cwd: "/runtime/workspace",
        },
      } as ListSessionsResponse["sessions"][number],
    ]),
  );

  assert.deepEqual(target, {
    kind: "live",
    sessionId: "runtime-1",
    workspaceDir: "/remembered/workspace",
  });
});

test("page refresh restores stopped history by stable provider identity", () => {
  const stored = {
    provider: "codex",
    providerSessionId: "provider-session-2",
    rootDir: "/history/workspace",
  } as ListSessionsResponse["storedSessions"][number];
  const target = resolveHistorySelectionRestoreTarget(
    { provider: "codex", providerSessionId: "provider-session-2" },
    response([], [stored], [stored]),
  );

  assert.deepEqual(target, {
    kind: "stored",
    ref: stored,
    workspaceDir: "/history/workspace",
  });
});

test("page refresh drops a selection that no longer exists", () => {
  assert.equal(
    resolveHistorySelectionRestoreTarget(
      { provider: "codex", providerSessionId: "deleted" },
      response(),
    ),
    null,
  );
});
