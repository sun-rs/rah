import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "./event-bus";
import { prepareProviderSessionResume } from "./provider-resume";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";

function createServices() {
  return {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
}

test("prepareProviderSessionResume restores a removed replay session on rollback", () => {
  const services = createServices();
  const replay = services.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: "provider-1",
    launchSource: "web",
    cwd: "/tmp/rah-provider-resume",
    rootDir: "/tmp/rah-provider-resume",
    title: "Replay session",
    capabilities: {
      steerInput: false,
    },
  });
  services.sessionStore.setRuntimeState(replay.session.id, "idle");
  const rehydratedSessionIds = new Set([replay.session.id]);

  const prepared = prepareProviderSessionResume({
    services,
    provider: "codex",
    providerSessionId: "provider-1",
    preferStoredReplay: false,
    rehydratedSessionIds,
  });

  assert.equal(services.sessionStore.getSession(replay.session.id), undefined);
  assert.equal(rehydratedSessionIds.has(replay.session.id), false);

  prepared.rollback();

  const restored = services.sessionStore.getSession(replay.session.id);
  assert.equal(restored?.session.providerSessionId, "provider-1");
  assert.equal(restored?.session.title, "Replay session");
  assert.equal(rehydratedSessionIds.has(replay.session.id), true);
  assert.equal(
    services.sessionStore.findManagedByProviderSession("codex", "provider-1")?.session.id,
    replay.session.id,
  );
  assert.deepEqual(
    services
      .eventBus
      .list({ sessionIds: [replay.session.id] })
      .map((event) => event.type),
    ["session.closed", "session.created", "session.started"],
  );
});

test("prepareProviderSessionResume rollback does not overwrite a replacement live session", () => {
  const services = createServices();
  const replay = services.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: "provider-1",
    launchSource: "web",
    cwd: "/tmp/rah-provider-resume",
    rootDir: "/tmp/rah-provider-resume",
  });
  const rehydratedSessionIds = new Set([replay.session.id]);
  const prepared = prepareProviderSessionResume({
    services,
    provider: "codex",
    providerSessionId: "provider-1",
    preferStoredReplay: false,
    rehydratedSessionIds,
  });
  const live = services.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: "provider-1",
    launchSource: "web",
    cwd: "/tmp/rah-provider-resume",
    rootDir: "/tmp/rah-provider-resume",
    capabilities: {
      steerInput: true,
    },
  });

  prepared.rollback();

  assert.equal(services.sessionStore.getSession(replay.session.id), undefined);
  assert.equal(
    services.sessionStore.findManagedByProviderSession("codex", "provider-1")?.session.id,
    live.session.id,
  );
  assert.equal(rehydratedSessionIds.has(replay.session.id), false);
});
