import assert from "node:assert/strict";
import test from "node:test";
import type {
  ProviderAdapter,
  ProviderStoredHistoryAdapter,
  ProviderStructuredLifecycleAdapter,
} from "./provider-adapter";
import {
  bindStructuredLifecycleCapability,
  bindStoredHistoryCapability,
  hasStructuredLifecycleCapability,
  hasStoredHistoryCapability,
} from "./provider-capability-bindings";

test("stored history capability preserves Conversation paging methods", async () => {
  const adapter: ProviderAdapter & ProviderStoredHistoryAdapter = {
    id: "history-canonical",
    providers: ["codex"],
    async getConversationSummaryEvidencePage(sessionId) {
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
    (await capability.getConversationSummaryEvidencePage?.("session-1"))?.nextCursor,
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

test("structured lifecycle capability preserves provider-native forkSession", async () => {
  let invokedWithBoundAdapter = false;
  const adapter: ProviderAdapter & ProviderStructuredLifecycleAdapter = {
    id: "structured-fork",
    providers: ["codex"],
    async forkSession(parentSessionId, request) {
      invokedWithBoundAdapter = this === adapter;
      throw new Error(`${parentSessionId}:${request.kind}:${request.workspaceMode}`);
    },
  };

  assert.equal(hasStructuredLifecycleCapability(adapter), true);
  const capability = bindStructuredLifecycleCapability(adapter);
  const forkSession = capability.forkSession;
  assert.ok(forkSession);
  await assert.rejects(
    async () =>
      await forkSession("parent-1", {
        operationId: "fork-operation-1",
        kind: "side",
        workspaceMode: "shared",
        attach: {
          client: { id: "web-user", kind: "web", connectionId: "connection-1" },
          mode: "interactive",
          claimControl: true,
        },
      }),
    /parent-1:side:shared/,
  );
  assert.equal(invokedWithBoundAdapter, true);
});
