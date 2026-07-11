import assert from "node:assert/strict";
import test from "node:test";
import type {
  ProviderAdapter,
  ProviderStoredHistoryAdapter,
} from "./provider-adapter";
import {
  bindStoredHistoryCapability,
  hasStoredHistoryCapability,
} from "./provider-capability-bindings";

test("stored history capability preserves Conversation V2 paging methods", async () => {
  const adapter: ProviderAdapter & ProviderStoredHistoryAdapter = {
    id: "history-v2",
    providers: ["codex"],
    async getSessionConversationHistoryPage(sessionId) {
      return { sessionId, events: [], nextCursor: "older" };
    },
    async getSessionConversationItemDetail(sessionId) {
      return { sessionId, events: [] };
    },
    async getSessionConversationTurnDetail(sessionId) {
      return { sessionId, events: [], nextCursor: "turn-detail" };
    },
  };

  assert.equal(hasStoredHistoryCapability(adapter), true);
  const capability = bindStoredHistoryCapability(adapter);
  assert.equal(
    (await capability.getSessionConversationHistoryPage?.("session-1"))?.nextCursor,
    "older",
  );
  assert.equal(
    (await capability.getSessionConversationItemDetail?.("session-1", {
      providerTurnId: "turn-1",
      providerItemId: "item-1",
    }))?.sessionId,
    "session-1",
  );
  assert.equal(
    (await capability.getSessionConversationTurnDetail?.("session-1", {
      providerTurnId: "turn-1",
    }))?.nextCursor,
    "turn-detail",
  );
});
