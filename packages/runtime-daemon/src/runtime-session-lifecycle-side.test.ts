import assert from "node:assert/strict";
import { test } from "node:test";
import { EventBus } from "./event-bus";
import { PtyHub } from "./pty-hub";
import { RuntimeSessionLifecycle } from "./runtime-session-lifecycle";
import { SessionStore } from "./session-store";

test("closing a parent destroys ephemeral Side children but preserves persistent forks", async () => {
  const eventBus = new EventBus();
  const ptyHub = new PtyHub();
  const sessionStore = new SessionStore();
  const parent = sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: "thread-parent",
    launchSource: "web",
    cwd: "/workspace/demo",
    rootDir: "/workspace/demo",
  });
  const side = sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: "thread-side",
    launchSource: "web",
    cwd: "/workspace/demo",
    rootDir: "/workspace/demo",
    relationship: {
      parentSessionId: parent.session.id,
      parentProviderSessionId: "thread-parent",
      kind: "side",
      workspaceMode: "shared",
      persistence: "ephemeral",
    },
  });
  const fork = sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: "thread-fork",
    launchSource: "web",
    cwd: "/workspace/demo",
    rootDir: "/workspace/demo",
    relationship: {
      parentSessionId: parent.session.id,
      parentProviderSessionId: "thread-parent",
      kind: "fork",
      workspaceMode: "shared",
      persistence: "persistent",
    },
  });
  for (const state of [parent, side, fork]) {
    sessionStore.attachClient({
      sessionId: state.session.id,
      clientId: "web-user",
      kind: "web",
      connectionId: "connection-1",
      attachMode: "interactive",
      focus: true,
    });
  }

  const destroyed: string[] = [];
  const closed: string[] = [];
  const clearedSnapshots: string[] = [];
  const removedOwners: string[] = [];
  const adapter = {
    id: "codex",
    providers: ["codex" as const],
    closeSession: async (sessionId: string) => {
      closed.push(sessionId);
    },
    destroySession: async (sessionId: string) => {
      destroyed.push(sessionId);
    },
  };
  const lifecycle = new RuntimeSessionLifecycle({
    eventBus,
    ptyHub,
    sessionStore,
    historySnapshots: {
      clear: (sessionId: string) => {
        clearedSnapshots.push(sessionId);
      },
    } as never,
    terminals: {
      closeNativeTuiSession: async () => false,
      closeNativeLocalServerTuiClient: async () => undefined,
    } as never,
    rememberSession: () => undefined,
    setSessionTitleOverride: () => undefined,
    refreshRememberedState: () => undefined,
    publishStoredSessionDiscovery: () => undefined,
    removeStructuredSessionOwner: (sessionId) => {
      removedOwners.push(sessionId);
    },
    releaseTimelineSessionState: () => undefined,
    requireStructuredLifecycleAdapter: () => adapter,
    requireActionCapabilityAdapter: () => adapter,
    requireEnhancedModeAdapter: () => adapter,
    requireEnhancedModelAdapter: () => adapter,
  });

  await lifecycle.closeSession(parent.session.id, { clientId: "web-user" });

  assert.deepEqual(destroyed, [side.session.id]);
  assert.deepEqual(closed, [parent.session.id]);
  assert.equal(sessionStore.getSession(parent.session.id), undefined);
  assert.equal(sessionStore.getSession(side.session.id), undefined);
  assert.equal(sessionStore.getSession(fork.session.id)?.session.id, fork.session.id);
  assert.deepEqual(new Set(clearedSnapshots), new Set([parent.session.id, side.session.id]));
  assert.deepEqual(new Set(removedOwners), new Set([parent.session.id, side.session.id]));
  const closedEvents = eventBus.list().filter((event) => event.type === "session.closed");
  assert.deepEqual(
    closedEvents.map((event) => [event.sessionId, event.payload.disposition]),
    [
      [side.session.id, "parent_closed"],
      [parent.session.id, "stopped"],
    ],
  );
});

test("failed Side disposal keeps the parent and child recoverable for retry", async () => {
  const eventBus = new EventBus();
  const ptyHub = new PtyHub();
  const sessionStore = new SessionStore();
  const parent = sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: "thread-parent-retry",
    launchSource: "web",
    cwd: "/workspace/retry",
    rootDir: "/workspace/retry",
  });
  const side = sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: "thread-side-retry",
    launchSource: "web",
    cwd: "/workspace/retry",
    rootDir: "/workspace/retry",
    relationship: {
      parentSessionId: parent.session.id,
      parentProviderSessionId: "thread-parent-retry",
      kind: "side",
      workspaceMode: "shared",
      persistence: "ephemeral",
    },
  });
  for (const state of [parent, side]) {
    sessionStore.attachClient({
      sessionId: state.session.id,
      clientId: "web-retry",
      kind: "web",
      connectionId: "connection-retry",
      attachMode: "interactive",
      focus: true,
    });
  }

  let failSideDisposal = true;
  const destroyed: string[] = [];
  const closed: string[] = [];
  const removedOwners: string[] = [];
  const adapter = {
    id: "codex",
    providers: ["codex" as const],
    closeSession: async (sessionId: string) => {
      closed.push(sessionId);
    },
    destroySession: async (sessionId: string) => {
      destroyed.push(sessionId);
      if (failSideDisposal) {
        throw new Error("provider Side cleanup failed");
      }
    },
  };
  const lifecycle = new RuntimeSessionLifecycle({
    eventBus,
    ptyHub,
    sessionStore,
    historySnapshots: { clear: () => undefined } as never,
    terminals: {
      closeNativeTuiSession: async () => false,
      closeNativeLocalServerTuiClient: async () => undefined,
    } as never,
    rememberSession: () => undefined,
    setSessionTitleOverride: () => undefined,
    refreshRememberedState: () => undefined,
    publishStoredSessionDiscovery: () => undefined,
    removeStructuredSessionOwner: (sessionId) => {
      removedOwners.push(sessionId);
    },
    releaseTimelineSessionState: () => undefined,
    requireStructuredLifecycleAdapter: () => adapter,
    requireActionCapabilityAdapter: () => adapter,
    requireEnhancedModeAdapter: () => adapter,
    requireEnhancedModelAdapter: () => adapter,
  });

  await assert.rejects(
    lifecycle.closeSession(parent.session.id, { clientId: "web-retry" }),
    /provider Side cleanup failed/,
  );
  assert.equal(sessionStore.getSession(parent.session.id)?.session.id, parent.session.id);
  assert.equal(sessionStore.getSession(side.session.id)?.session.id, side.session.id);
  assert.equal(
    sessionStore.getSession(side.session.id)?.session.relationship?.sideState,
    "cleanup_failed",
  );
  assert.match(
    sessionStore.getSession(side.session.id)?.session.relationship?.sideStateDetail ?? "",
    /provider Side cleanup failed/,
  );
  assert.deepEqual(closed, []);
  assert.deepEqual(removedOwners, []);

  failSideDisposal = false;
  await lifecycle.closeSession(parent.session.id, { clientId: "web-retry" });
  assert.equal(sessionStore.getSession(parent.session.id), undefined);
  assert.equal(sessionStore.getSession(side.session.id), undefined);
  assert.deepEqual(destroyed, [side.session.id, side.session.id]);
  assert.deepEqual(closed, [parent.session.id]);
});

test("missing Side destroy support keeps parent and child visible", async () => {
  const eventBus = new EventBus();
  const ptyHub = new PtyHub();
  const sessionStore = new SessionStore();
  const parent = sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: "thread-parent-unsupported",
    launchSource: "web",
    cwd: "/workspace/unsupported",
    rootDir: "/workspace/unsupported",
  });
  const side = sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: "thread-side-unsupported",
    launchSource: "web",
    cwd: "/workspace/unsupported",
    rootDir: "/workspace/unsupported",
    relationship: {
      parentSessionId: parent.session.id,
      parentProviderSessionId: "thread-parent-unsupported",
      kind: "side",
      workspaceMode: "shared",
      persistence: "ephemeral",
    },
  });
  for (const state of [parent, side]) {
    sessionStore.attachClient({
      sessionId: state.session.id,
      clientId: "web-unsupported",
      kind: "web",
      connectionId: "connection-unsupported",
      attachMode: "interactive",
      focus: true,
    });
  }

  const adapter = {
    id: "codex",
    providers: ["codex" as const],
    closeSession: async () => undefined,
  };
  const lifecycle = new RuntimeSessionLifecycle({
    eventBus,
    ptyHub,
    sessionStore,
    historySnapshots: { clear: () => undefined } as never,
    terminals: {
      closeNativeTuiSession: async () => false,
      closeNativeLocalServerTuiClient: async () => undefined,
    } as never,
    rememberSession: () => undefined,
    setSessionTitleOverride: () => undefined,
    refreshRememberedState: () => undefined,
    publishStoredSessionDiscovery: () => undefined,
    removeStructuredSessionOwner: () => undefined,
    releaseTimelineSessionState: () => undefined,
    requireStructuredLifecycleAdapter: () => adapter,
    requireActionCapabilityAdapter: () => adapter,
    requireEnhancedModeAdapter: () => adapter,
    requireEnhancedModelAdapter: () => adapter,
  });

  await assert.rejects(
    lifecycle.closeSession(parent.session.id, { clientId: "web-unsupported" }),
    /cannot destroy Side session/,
  );
  assert.equal(sessionStore.getSession(parent.session.id)?.session.id, parent.session.id);
  assert.equal(sessionStore.getSession(side.session.id)?.session.id, side.session.id);
  assert.equal(
    sessionStore.getSession(side.session.id)?.session.relationship?.sideState,
    "cleanup_failed",
  );
});

test("explicit Side discard publishes a terminal Side state before removing the session", async () => {
  const eventBus = new EventBus();
  const ptyHub = new PtyHub();
  const sessionStore = new SessionStore();
  const parent = sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: "thread-parent-discard",
    launchSource: "web",
    cwd: "/workspace/discard",
    rootDir: "/workspace/discard",
  });
  const side = sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: "thread-side-discard",
    launchSource: "web",
    cwd: "/workspace/discard",
    rootDir: "/workspace/discard",
    relationship: {
      parentSessionId: parent.session.id,
      parentProviderSessionId: "thread-parent-discard",
      kind: "side",
      workspaceMode: "shared",
      persistence: "ephemeral",
      sideState: "completed",
    },
  });
  sessionStore.attachClient({
    sessionId: side.session.id,
    clientId: "web-discard",
    kind: "web",
    connectionId: "connection-discard",
    attachMode: "interactive",
    focus: true,
  });
  const adapter = {
    id: "codex",
    providers: ["codex" as const],
    closeSession: async () => undefined,
    destroySession: async () => undefined,
  };
  const lifecycle = new RuntimeSessionLifecycle({
    eventBus,
    ptyHub,
    sessionStore,
    historySnapshots: { clear: () => undefined } as never,
    terminals: {
      closeNativeTuiSession: async () => false,
      closeNativeLocalServerTuiClient: async () => undefined,
    } as never,
    rememberSession: () => undefined,
    setSessionTitleOverride: () => undefined,
    refreshRememberedState: () => undefined,
    publishStoredSessionDiscovery: () => undefined,
    removeStructuredSessionOwner: () => undefined,
    releaseTimelineSessionState: () => undefined,
    requireStructuredLifecycleAdapter: () => adapter,
    requireActionCapabilityAdapter: () => adapter,
    requireEnhancedModeAdapter: () => adapter,
    requireEnhancedModelAdapter: () => adapter,
  });

  await lifecycle.closeSession(side.session.id, { clientId: "web-discard" });

  assert.equal(sessionStore.getSession(side.session.id), undefined);
  const terminalEvents = eventBus
    .list({ sessionIds: [side.session.id] })
    .filter(
      (event) =>
        event.type === "session.side.state.changed" || event.type === "session.closed",
    );
  assert.deepEqual(
    terminalEvents.map((event) =>
      event.type === "session.side.state.changed"
        ? [event.type, event.payload.state]
        : [event.type, event.payload.disposition],
    ),
    [
      ["session.side.state.changed", "discarded"],
      ["session.closed", "discarded"],
    ],
  );
});
