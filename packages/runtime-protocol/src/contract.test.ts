import assert from "node:assert/strict";
import test from "node:test";
import { validateProviderModelCatalog, validateRahEvent } from "./contract";

const baseCatalog = {
  provider: "codex",
  models: [],
  fetchedAt: "2026-04-29T00:00:00.000Z",
  source: "native",
  modes: [
    {
      id: "never/danger-full-access",
      role: "full_auto",
      label: "Full auto",
      applyTiming: "next_turn",
      hotSwitch: true,
    },
  ],
};

test("provider model catalog accepts canonical mode apply timing", () => {
  const report = validateProviderModelCatalog(baseCatalog);
  assert.equal(report.ok, true);
});

test("provider model catalog accepts canonical runtime metadata", () => {
  const report = validateProviderModelCatalog({
    ...baseCatalog,
    runtime: {
      kind: "native_local_server",
      protocolStability: "project_native",
      liveSource: "provider_server",
      tuiRole: "client_view",
      structuredLiveEvents: true,
      tuiContinuity: true,
      features: {
        structuredLiveEvents: "available",
        structuredControl: "available",
        historyBackfill: "available",
        tuiClientContinuity: "unverified",
        crossClientSync: "unverified",
        prelaunchConfig: "available",
        runtimeConfig: "unverified",
        interrupt: "available",
        archiveLifecycle: "available",
      },
    },
  });
  assert.equal(report.ok, true);
});

test("provider model catalog rejects non-canonical runtime metadata", () => {
  const report = validateProviderModelCatalog({
    ...baseCatalog,
    runtime: {
      kind: "magic_socket",
      protocolStability: "vibes",
      liveSource: "screen_scrape",
      tuiRole: "maybe",
      structuredLiveEvents: true,
      tuiContinuity: true,
      features: {
        structuredLiveEvents: "maybe",
      },
    },
  });
  assert.equal(report.ok, false);
  assert.equal(report.errors[0]?.code, "session.runtime.kind.invalid");
});

test("provider model catalog rejects non-canonical runtime feature status", () => {
  const report = validateProviderModelCatalog({
    ...baseCatalog,
    runtime: {
      kind: "native_local_server",
      protocolStability: "project_native",
      liveSource: "provider_server",
      tuiRole: "client_view",
      structuredLiveEvents: true,
      tuiContinuity: false,
      features: {
        structuredLiveEvents: "maybe",
        structuredControl: "available",
        historyBackfill: "available",
        tuiClientContinuity: "unverified",
        crossClientSync: "unverified",
        prelaunchConfig: "available",
        runtimeConfig: "unverified",
        interrupt: "available",
        archiveLifecycle: "available",
      },
    },
  });
  assert.equal(report.ok, false);
  assert.equal(
    report.errors.some((error) => error.code === "session.runtime.features.status.invalid"),
    true,
  );
});

function buildSessionCreatedEvent(
  sessionPatch: Record<string, unknown> = {},
): Parameters<typeof validateRahEvent>[0] {
  return {
    id: "evt-session-created",
    seq: 1,
    ts: "2026-04-29T00:00:00.000Z",
    sessionId: "session-1",
    type: "session.created",
    source: { provider: "system", channel: "system", authority: "authoritative" },
    payload: {
      session: {
        id: "session-1",
        provider: "opencode",
        providerSessionId: "opencode-1",
        launchSource: "web",
        liveBackend: "native_local_server",
        cwd: "/tmp/rah",
        rootDir: "/tmp/rah",
        runtimeState: "idle",
        runtime: {
          kind: "native_local_server",
          protocolStability: "project_native",
          liveSource: "provider_server",
          tuiRole: "client_view",
          structuredLiveEvents: true,
          tuiContinuity: true,
        },
        ptyId: "pty-1",
        capabilities: {
          liveAttach: true,
          structuredTimeline: true,
          nativeTui: false,
          rawPtyInput: false,
          chatMirror: false,
          structuredControl: true,
          livePermissions: true,
          contextUsage: true,
          resumeByProvider: true,
          listProviderSessions: true,
          renameSession: false,
          actions: {
            info: true,
            archive: true,
            delete: false,
            rename: "none",
          },
          steerInput: true,
          queuedInput: true,
          modelSwitch: true,
          planMode: false,
          subagents: false,
        },
        createdAt: "2026-04-29T00:00:00.000Z",
        updatedAt: "2026-04-29T00:00:00.000Z",
        ...sessionPatch,
      },
    },
  } as Parameters<typeof validateRahEvent>[0];
}

test("session events accept canonical runtime diagnostics", () => {
  const issues = validateRahEvent(
    buildSessionCreatedEvent({
      runtimeDiagnostics: {
        serverEndpoint: "http://127.0.0.1:40999",
        serverPid: 12345,
        attachCommand: "opencode attach http://127.0.0.1:40999",
        attachState: "ready",
        lastEventCursor: "session:opencode-1",
      },
    }),
  );
  assert.equal(issues.some((issue) => issue.severity === "error"), false);
});

test("session events accept tmux mux metadata without zellij socketDir", () => {
  const issues = validateRahEvent(
    buildSessionCreatedEvent({
      liveBackend: "zellij_tui",
      mux: {
        backend: "tmux",
        sessionName: "rah-session-1234",
        paneId: "%1",
      },
    }),
  );
  assert.equal(issues.some((issue) => issue.severity === "error"), false);
});

test("session events reject non-canonical runtime diagnostics", () => {
  const issues = validateRahEvent(
    buildSessionCreatedEvent({
      runtimeDiagnostics: {
        serverEndpoint: "",
        serverPid: -1,
        attachState: "maybe",
      },
    }),
  );
  assert.equal(
    issues.some((issue) => issue.code === "session.runtime_diagnostics.string.invalid"),
    true,
  );
  assert.equal(
    issues.some((issue) => issue.code === "session.runtime_diagnostics.server_pid.invalid"),
    true,
  );
  assert.equal(
    issues.some((issue) => issue.code === "session.runtime_diagnostics.attach_state.invalid"),
    true,
  );
});

test("provider model catalog rejects non-canonical mode apply timing", () => {
  const report = validateProviderModelCatalog({
    ...baseCatalog,
    modes: [
      {
        ...baseCatalog.modes[0],
        applyTiming: "after_lunch",
      },
    ],
  });
  assert.equal(report.ok, false);
  assert.equal(report.errors[0]?.code, "provider.catalog.mode.apply_timing.invalid");
});

test("session capability contract warns when legacy rename flag drifts from actions.rename", () => {
  const issues = validateRahEvent({
    id: "evt-1",
    seq: 1,
    ts: "2026-04-29T00:00:00.000Z",
    sessionId: "session-1",
    type: "session.created",
    source: { provider: "system", channel: "system", authority: "authoritative" },
    payload: {
      session: {
        id: "session-1",
        provider: "opencode",
        providerSessionId: "opencode-1",
        launchSource: "web",
        cwd: "/tmp/rah",
        rootDir: "/tmp/rah",
        runtimeState: "idle",
        runtime: {
          kind: "tui_mux_fallback",
          protocolStability: "tui_stdio",
          liveSource: "provider_history",
          tuiRole: "session_owner",
          structuredLiveEvents: false,
          tuiContinuity: true,
        },
        ptyId: "pty-1",
        capabilities: {
          liveAttach: true,
          structuredTimeline: true,
          nativeTui: false,
          rawPtyInput: false,
          chatMirror: false,
          structuredControl: true,
          livePermissions: false,
          contextUsage: true,
          resumeByProvider: true,
          listProviderSessions: true,
          renameSession: false,
          actions: {
            info: true,
            archive: true,
            delete: true,
            rename: "local",
          },
          steerInput: true,
          queuedInput: false,
          modelSwitch: true,
          planMode: true,
          subagents: false,
        },
        createdAt: "2026-04-29T00:00:00.000Z",
        updatedAt: "2026-04-29T00:00:00.000Z",
      },
    },
  });
  assert.equal(issues.some((issue) => issue.severity === "error"), false);
  assert.equal(
    issues.some((issue) => issue.code === "session.capabilities.rename_legacy_mismatch"),
    true,
  );
});

test("native TUI prompt state events use canonical values", () => {
  const valid = validateRahEvent({
    id: "evt-native-prompt-1",
    seq: 1,
    ts: "2026-04-29T00:00:00.000Z",
    sessionId: "session-1",
    type: "session.native_tui.prompt_state.changed",
    source: { provider: "system", channel: "system", authority: "authoritative" },
    payload: { promptState: "prompt_dirty", queuedInputCount: 1 },
  });
  assert.equal(valid.some((issue) => issue.severity === "error"), false);

  const invalid = validateRahEvent({
    id: "evt-native-prompt-2",
    seq: 2,
    ts: "2026-04-29T00:00:01.000Z",
    sessionId: "session-1",
    type: "session.native_tui.prompt_state.changed",
    source: { provider: "system", channel: "system", authority: "authoritative" },
    payload: { promptState: "clean" },
  } as never);
  assert.equal(
    invalid.some((issue) => issue.code === "session.native_tui.prompt_state.invalid"),
    true,
  );
});
