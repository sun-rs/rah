import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationItemProjection,
  ConversationTurnProjection,
} from "@rah/runtime-protocol";

import {
  conversationHasExternalActivity,
  resolveConversationHeaderState,
} from "./conversation-header-meta";

function turn(
  status: ConversationTurnProjection["status"],
  itemStatus: ConversationItemProjection["status"] = "completed",
): ConversationTurnProjection {
  return {
    id: `turn-${status}`,
    provider: "codex",
    status,
    statusAuthority: "native",
    items: [
      {
        id: `item-${itemStatus}`,
        turnId: `turn-${status}`,
        role: "process",
        status: itemStatus,
        content: {
          kind: "message_part",
          part: {
            messageId: "message-1",
            partId: "part-1",
            kind: "text",
            text: "status",
          },
        },
        source: {
          provider: "codex",
          channel: "structured_persisted",
          authority: "authoritative",
        },
        revision: 1,
      },
    ],
    activities: [],
    failedItemCount: 0,
    revision: 1,
  };
}

test("uses only the latest provider turn to derive external activity", () => {
  assert.equal(
    conversationHasExternalActivity({
      turns: [turn("in_progress"), turn("completed")],
    }),
    false,
  );
  assert.equal(
    conversationHasExternalActivity({
      turns: [turn("completed"), turn("in_progress")],
    }),
    true,
  );
  assert.equal(
    conversationHasExternalActivity({
      turns: [turn("completed", "running")],
    }),
    true,
  );
});

test("does not call an externally active provider session stopped", () => {
  assert.deepEqual(
    resolveConversationHeaderState({
      status: "stopped",
      phase: "ended",
      externalActivity: true,
    }),
    {
      label: "Working externally",
      tone: "working",
      icon: "activity",
      title: "Provider activity is continuing outside RAH",
    },
  );
  assert.equal(
    resolveConversationHeaderState({
      status: "stopped",
      phase: "ended",
    }).label,
    "Stopped",
  );
});
