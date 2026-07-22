import assert from "node:assert/strict";
import test from "node:test";
import { createCodexAppServerTranslationState } from "./codex-app-server-activity";
import {
  createLiveSessionBridge,
  shouldApplyCodexTranslatedActivity,
} from "./codex-live-helpers";
import type { CodexAppServerRpcClient } from "./codex-live-rpc";
import type {
  JsonRpcNotification,
  LiveCodexSession,
} from "./codex-live-types";
import { EventBus } from "./event-bus";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";
import { TurnArtifactStore } from "./turn-artifact-store";

test("notification flush reaches a stable queue boundary before returning", async () => {
  let notificationHandler: (notification: JsonRpcNotification) => void = () => {};
  const client: CodexAppServerRpcClient = {
    setNotificationHandler(handler) {
      notificationHandler = handler;
    },
    setRequestHandler() {},
    setCloseHandler() {},
    async request() {
      return {};
    },
    notify() {},
    async dispose() {},
  };
  let releaseFirstWrite: () => void = () => {};
  const firstWriteGate = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  const writtenDiffs: string[] = [];
  class BlockingTurnArtifactStore extends TurnArtifactStore {
    override async replaceTurnDiff(
      _sessionId: string,
      _turnId: string,
      unifiedDiff: string,
    ) {
      writtenDiffs.push(unifiedDiff);
      if (writtenDiffs.length === 1) {
        await firstWriteGate;
      }
      return {
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
      };
    }
  }
  const turnArtifacts = new BlockingTurnArtifactStore();
  const eventBus = new EventBus();
  const sessionStore = new SessionStore();
  const sessionId = sessionStore.createManagedSession({
    id: "session-1",
    provider: "codex",
    providerSessionId: "thread-1",
    launchSource: "web",
    liveBackend: "structured",
    cwd: "/workspace/demo",
    rootDir: "/workspace/demo",
    title: "demo",
  }).session.id;
  const services = {
    eventBus,
    ptyHub: new PtyHub(),
    sessionStore,
    turnArtifacts,
  };
  const bridge = createLiveSessionBridge(services, client);
  const liveSession: LiveCodexSession = {
    sessionId,
    threadId: "thread-1",
    cwd: "/workspace/demo",
    approvalPolicy: "on-request",
    sandboxMode: "workspace-write",
    approvalsReviewer: "user",
    modelId: null,
    reasoningId: null,
    modelCatalog: null,
    activeModeId: "default",
    lastNonPlanModeId: "default",
    planCollaborationMode: null,
    client,
    translationState: createCodexAppServerTranslationState(),
    currentTurnId: "turn-1",
    finishedTurnIds: new Set(),
    interruptingTurnIds: new Set(),
    turnStartInFlight: false,
    interruptWhenTurnStarts: false,
    queuedInputs: [],
    externalThreadMirrorSubscribeInFlight: false,
    externalThreadMirrorSubscribed: true,
    pendingQuestions: new Map(),
    pendingApprovals: new Map(),
  };
  bridge.activate(liveSession);

  const firstDiff = `diff --git a/src/first.ts b/src/first.ts
--- a/src/first.ts
+++ b/src/first.ts
@@ -1 +1 @@
-old
+first
`;
  const secondDiff = `diff --git a/src/second.ts b/src/second.ts
--- a/src/second.ts
+++ b/src/second.ts
@@ -1 +1 @@
-old
+second
`;
  notificationHandler({
    method: "turn/diff/updated",
    params: { threadId: "thread-1", turnId: "turn-1", diff: firstDiff },
  });
  const flush = liveSession.flushNotifications?.();
  assert.ok(flush);
  notificationHandler({
    method: "turn/diff/updated",
    params: { threadId: "thread-1", turnId: "turn-1", diff: secondDiff },
  });
  releaseFirstWrite();
  await flush;

  assert.deepEqual(writtenDiffs, [firstDiff, secondDiff]);
  assert.equal(
    eventBus.list({ eventTypes: ["turn.file_changes.updated"] }).length,
    2,
  );
});

test("skips inactive snapshot session state while a live Codex turn is active", () => {
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "session_state", state: "idle" },
      origin: "snapshot",
      currentTurnId: "turn-live",
    }),
    false,
  );
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "session_state", state: "failed" },
      origin: "snapshot",
      currentTurnId: "turn-live",
    }),
    false,
  );
});

test("applies active snapshot state and all live notification state", () => {
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "session_state", state: "running" },
      origin: "snapshot",
      currentTurnId: "turn-live",
    }),
    true,
  );
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "session_state", state: "waiting_permission" },
      origin: "snapshot",
      currentTurnId: "turn-live",
    }),
    true,
  );
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "session_state", state: "idle" },
      origin: "notification",
      currentTurnId: "turn-live",
    }),
    true,
  );
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "session_state", state: "idle" },
      origin: "snapshot",
      currentTurnId: null,
    }),
    true,
  );
});

test("skips session authority events from a different Codex thread", () => {
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "turn_completed", turnId: "subagent-turn" },
      origin: "notification",
      currentTurnId: "main-turn",
      providerSessionId: "thread-subagent",
      mainProviderSessionId: "thread-main",
    }),
    false,
  );
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "session_state", state: "idle" },
      origin: "notification",
      currentTurnId: "main-turn",
      providerSessionId: "thread-subagent",
      mainProviderSessionId: "thread-main",
    }),
    false,
  );
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "runtime_status", status: "finished" },
      origin: "notification",
      currentTurnId: "main-turn",
      providerSessionId: "thread-subagent",
      mainProviderSessionId: "thread-main",
    }),
    false,
  );
});

test("keeps visible subagent observations while filtering only session authority", () => {
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: {
        type: "observation_completed",
        turnId: "subagent-turn",
        observation: {
          id: "subagent-1",
          kind: "subagent.lifecycle",
          status: "completed",
          title: "Subagent activity",
        },
      },
      origin: "notification",
      currentTurnId: "main-turn",
      providerSessionId: "thread-subagent",
      mainProviderSessionId: "thread-main",
    }),
    true,
  );
});

test("skips non-lifecycle activity from different Codex threads", () => {
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: {
        type: "timeline_item",
        turnId: "subagent-turn",
        item: { kind: "user_message", text: "internal prompt" },
      },
      origin: "notification",
      currentTurnId: "main-turn",
      providerSessionId: "thread-subagent",
      mainProviderSessionId: "thread-main",
    }),
    false,
  );
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: {
        type: "tool_call_started",
        turnId: "subagent-turn",
        toolCall: {
          id: "tool-subagent",
          family: "other",
          providerToolName: "read",
          title: "Read",
        },
      },
      origin: "notification",
      currentTurnId: "main-turn",
      providerSessionId: "thread-subagent",
      mainProviderSessionId: "thread-main",
    }),
    false,
  );
});

test("applies main thread lifecycle events", () => {
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "turn_completed", turnId: "main-turn" },
      origin: "notification",
      currentTurnId: "main-turn",
      providerSessionId: "thread-main",
      mainProviderSessionId: "thread-main",
    }),
    true,
  );
});

test("skips unidentified lifecycle events for a different active turn", () => {
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "turn_completed", turnId: "subagent-turn" },
      origin: "notification",
      currentTurnId: "main-turn",
    }),
    false,
  );
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "turn_completed", turnId: "current-turn" },
      origin: "notification",
      currentTurnId: "main-turn",
    }),
    true,
  );
});

test("rejects a different turn lifecycle even when it names the main thread", () => {
  assert.equal(
    shouldApplyCodexTranslatedActivity({
      activity: { type: "turn_started", turnId: "main-turn-2" },
      origin: "notification",
      currentTurnId: "stale-turn",
      providerSessionId: "thread-main",
      mainProviderSessionId: "thread-main",
    }),
    false,
  );
});
