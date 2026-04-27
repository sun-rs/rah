import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "./event-bus";
import {
  interruptOpenCodeLiveSession,
  setOpenCodeLiveSessionMode,
  type LiveOpenCodeSession,
} from "./opencode-live-client";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";
import { buildOpenCodeModeState } from "./session-mode-utils";

test("interruptOpenCodeLiveSession requires input control before canceling", () => {
  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const session = services.sessionStore.createManagedSession({
    provider: "opencode",
    providerSessionId: "opencode-1",
    launchSource: "web",
    cwd: "/tmp/rah-opencode",
    rootDir: "/tmp/rah-opencode",
  });
  let cancelCalled = false;
  const liveSession = {
    sessionId: session.session.id,
    providerSessionId: "opencode-1",
    acp: {
      cancel: () => {
        cancelCalled = true;
      },
    },
  } as unknown as LiveOpenCodeSession;

  assert.throws(
    () =>
      interruptOpenCodeLiveSession({
        services,
        liveSession,
        request: {
          clientId: "web-client",
        },
      }),
    /does not hold input control/,
  );
  assert.equal(cancelCalled, false);
});

test("setOpenCodeLiveSessionMode applies ACP mode changes", async () => {
  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const session = services.sessionStore.createManagedSession({
    provider: "opencode",
    providerSessionId: "opencode-1",
    launchSource: "web",
    cwd: "/tmp/rah-opencode",
    rootDir: "/tmp/rah-opencode",
    mode: buildOpenCodeModeState({ currentModeId: "build", mutable: true }),
  });
  const calls: Array<{ sessionId: string; modeId: string }> = [];
  const liveSession = {
    sessionId: session.session.id,
    providerSessionId: "opencode-1",
    modeId: "build",
    acp: {
      setSessionMode: async (sessionId: string, modeId: string) => {
        calls.push({ sessionId, modeId });
      },
    },
  } as unknown as LiveOpenCodeSession;

  const summary = await setOpenCodeLiveSessionMode({
    services,
    liveSession,
    modeId: "plan",
  });

  assert.deepEqual(calls, [{ sessionId: "opencode-1", modeId: "plan" }]);
  assert.equal(liveSession.modeId, "plan");
  assert.equal(summary.session.mode?.currentModeId, "plan");
});
