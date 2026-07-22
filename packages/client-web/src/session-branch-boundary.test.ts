import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ConversationTurnProjection } from "@rah/runtime-protocol";
import { latestCompletedProviderTurnId } from "./session-branch-boundary";

function turn(
  id: string,
  status: ConversationTurnProjection["status"],
  providerTurnId?: string,
): ConversationTurnProjection {
  return {
    id,
    provider: "codex",
    ...(providerTurnId ? { providerTurnId } : {}),
    status,
    statusAuthority: "native",
    items: [],
    activities: [],
    failedItemCount: 0,
    revision: 1,
  };
}

describe("session branch boundary", () => {
  test("uses the newest completed native provider turn before an active tail", () => {
    assert.equal(
      latestCompletedProviderTurnId([
        turn("turn-1", "completed", "provider-1"),
        turn("turn-2", "completed", "provider-2"),
        turn("turn-3", "in_progress", "provider-3"),
      ]),
      "provider-2",
    );
  });

  test("skips completed projections without a native provider turn id", () => {
    assert.equal(
      latestCompletedProviderTurnId([
        turn("turn-1", "completed", "provider-1"),
        turn("turn-2", "completed"),
      ]),
      "provider-1",
    );
  });

  test("returns undefined when no completed provider turn is available", () => {
    assert.equal(
      latestCompletedProviderTurnId([
        turn("turn-1", "interrupted", "provider-1"),
        turn("turn-2", "in_progress", "provider-2"),
      ]),
      undefined,
    );
  });
});
