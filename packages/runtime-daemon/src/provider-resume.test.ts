import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "./event-bus";
import {
  prepareProviderSessionResume,
  reuseExistingProviderSessionForResume,
} from "./provider-resume";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";
import { runtimeDescriptorForStoredHistory } from "./session-runtime-descriptor";

function createServices() {
  return {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
}

test("SessionStore rejects duplicate provider session ownership", () => {
  const services = createServices();
  const live = services.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: "provider-1",
    launchSource: "web",
    cwd: "/tmp/rah-provider-resume",
    rootDir: "/tmp/rah-provider-resume",
  });

  assert.throws(
    () =>
      services.sessionStore.createManagedSession({
        provider: "codex",
        providerSessionId: "provider-1",
        launchSource: "web",
        cwd: "/tmp/rah-provider-resume",
        rootDir: "/tmp/rah-provider-resume",
      }),
    /already running; attach instead of resume/,
  );

  const other = services.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: "provider-2",
    launchSource: "web",
    cwd: "/tmp/rah-provider-resume",
    rootDir: "/tmp/rah-provider-resume",
  });
  assert.throws(
    () => services.sessionStore.patchManagedSession(other.session.id, { providerSessionId: "provider-1" }),
    /already running; attach instead of resume/,
  );
  assert.equal(
    services.sessionStore.findManagedByProviderSession("codex", "provider-1")?.session.id,
    live.session.id,
  );
});

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

test("prepareProviderSessionResume rollback does not overwrite a replacement running session", () => {
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

test("prepareProviderSessionResume replaces explicit history source replay even without rehydration marker", () => {
  const services = createServices();
  const replay = services.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: "provider-1",
    launchSource: "web",
    cwd: "/tmp/rah-provider-resume",
    rootDir: "/tmp/rah-provider-resume",
    capabilities: {
      steerInput: false,
    },
  });
  const rehydratedSessionIds = new Set<string>();

  prepareProviderSessionResume({
    services,
    provider: "codex",
    providerSessionId: "provider-1",
    preferStoredReplay: false,
    historySourceSessionId: replay.session.id,
    rehydratedSessionIds,
  });

  assert.equal(services.sessionStore.getSession(replay.session.id), undefined);
  assert.equal(
    services.sessionStore.findManagedByProviderSession("codex", "provider-1"),
    undefined,
  );
});

test("prepareProviderSessionResume replaces stored-history replay even when adapter markers differ", () => {
  const services = createServices();
  const replay = services.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: "provider-1",
    launchSource: "web",
    cwd: "/tmp/rah-provider-resume",
    rootDir: "/tmp/rah-provider-resume",
    runtime: runtimeDescriptorForStoredHistory(),
    capabilities: {
      steerInput: false,
      livePermissions: false,
    },
  });
  const rehydratedSessionIds = new Set<string>();

  prepareProviderSessionResume({
    services,
    provider: "codex",
    providerSessionId: "provider-1",
    preferStoredReplay: false,
    historySourceSessionId: "different-replay-id",
    rehydratedSessionIds,
  });

  assert.equal(services.sessionStore.getSession(replay.session.id), undefined);
  assert.equal(
    services.sessionStore.findManagedByProviderSession("codex", "provider-1"),
    undefined,
  );
});

test("prepareProviderSessionResume does not replace explicit history source when it is live", () => {
  const services = createServices();
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

  assert.throws(
    () =>
      prepareProviderSessionResume({
        services,
        provider: "codex",
        providerSessionId: "provider-1",
        preferStoredReplay: false,
        historySourceSessionId: live.session.id,
        rehydratedSessionIds: new Set(),
      }),
    /already running; attach instead of resume/,
  );
});

test("reuseExistingProviderSessionForResume attaches to a live provider session instead of throwing", () => {
  const services = createServices();
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

  const reused = reuseExistingProviderSessionForResume({
    services,
    provider: "codex",
    providerSessionId: "provider-1",
    preferStoredReplay: false,
    historySourceSessionId: live.session.id,
    rehydratedSessionIds: new Set(),
    attach: {
      mode: "interactive",
      claimControl: true,
      client: {
        id: "web-client",
        kind: "web",
        connectionId: "web-connection",
      },
    },
  });

  assert.equal(reused?.session.session.id, live.session.id);
  assert.equal(
    services.sessionStore.findManagedByProviderSession("codex", "provider-1")?.session.id,
    live.session.id,
  );
  assert.equal(
    services.eventBus.list({ sessionIds: [live.session.id] }).at(-1)?.type,
    "control.claimed",
  );
});

test("reuseExistingProviderSessionForResume lets live resume replace stored history", () => {
  const services = createServices();
  const replay = services.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: "provider-1",
    launchSource: "web",
    cwd: "/tmp/rah-provider-resume",
    rootDir: "/tmp/rah-provider-resume",
    runtime: runtimeDescriptorForStoredHistory(),
    capabilities: {
      steerInput: false,
    },
  });

  const reused = reuseExistingProviderSessionForResume({
    services,
    provider: "codex",
    providerSessionId: "provider-1",
    preferStoredReplay: false,
    historySourceSessionId: replay.session.id,
    rehydratedSessionIds: new Set(),
  });

  assert.equal(reused, null);
  assert.equal(services.sessionStore.getSession(replay.session.id)?.session.id, replay.session.id);
});
