import assert from "node:assert/strict";
import test from "node:test";
import {
  decisionFromPermissionActionId,
  normalizePermissionDecision,
} from "./api";
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

test("permission helpers normalize provider-native decisions at the adapter boundary", () => {
  assert.equal(normalizePermissionDecision("accept"), "approved");
  assert.equal(normalizePermissionDecision("acceptForSession"), "approved_for_session");
  assert.equal(normalizePermissionDecision("decline"), "denied");
  assert.equal(normalizePermissionDecision("cancel"), "abort");
  assert.equal(decisionFromPermissionActionId("acceptForSession"), "approved_for_session");
});

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
        stopLifecycle: "available",
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
        stopLifecycle: "available",
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
        status: "running",
        phase: "ready",
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
          actions: {
            info: true,
            stop: true,
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

test("session events reject runtime and user status disagreement", () => {
  const issues = validateRahEvent(
    buildSessionCreatedEvent({ runtimeState: "stopped", status: "running" }),
  );
  assert.equal(
    issues.some((issue) => issue.code === "session.status.runtime_mismatch"),
    true,
  );
});

test("session events reject non-boolean optional archive capability", () => {
  const event = buildSessionCreatedEvent();
  const payload = event.payload as {
    session: { capabilities: { actions: { archive?: unknown } } };
  };
  payload.session.capabilities.actions.archive = "yes";
  const issues = validateRahEvent(event);
  assert.equal(
    issues.some((issue) => issue.code === "session.capabilities.actions.archive.invalid"),
    true,
  );
});

test("session events reject non-boolean optional restore capability", () => {
  const event = buildSessionCreatedEvent();
  const payload = event.payload as {
    session: { capabilities: { actions: { restore?: unknown } } };
  };
  payload.session.capabilities.actions.restore = "yes";
  const issues = validateRahEvent(event);
  assert.equal(
    issues.some((issue) => issue.code === "session.capabilities.actions.restore.invalid"),
    true,
  );
});

test("session events accept canonical native branching and side relationships", () => {
  const event = buildSessionCreatedEvent({
    capabilities: {
      ...((buildSessionCreatedEvent().payload as { session: { capabilities: object } }).session.capabilities),
      branching: { sameWorkspace: true, worktree: false, side: true },
    },
    relationship: {
      parentSessionId: "session-parent",
      parentProviderSessionId: "thread-parent",
      forkPointTurnId: "turn-7",
      kind: "side",
      workspaceMode: "shared",
      persistence: "ephemeral",
      sideState: "completed",
    },
  });
  const issues = validateRahEvent(event);
  assert.equal(issues.some((issue) => issue.severity === "error"), false);
});

test("session events reject invalid branch relationships", () => {
  const issues = validateRahEvent(
    buildSessionCreatedEvent({
      relationship: {
        parentSessionId: "session-parent",
        kind: "copy",
        workspaceMode: "shared",
        persistence: "temporary",
      },
    }),
  );
  assert.equal(
    issues.some((issue) => issue.code === "session.relationship.kind.invalid"),
    true,
  );
  assert.equal(
    issues.some((issue) => issue.code === "session.relationship.persistence.invalid"),
    true,
  );
});

test("session events reject non-canonical Side and Fork relationship combinations", () => {
  const sideIssues = validateRahEvent(
    buildSessionCreatedEvent({
      relationship: {
        parentSessionId: "parent-session",
        kind: "side",
        workspaceMode: "worktree",
        persistence: "persistent",
      },
    }),
  );
  assert.equal(
    sideIssues.some((issue) => issue.code === "session.relationship.side_workspace.invalid"),
    true,
  );
  assert.equal(
    sideIssues.some(
      (issue) => issue.code === "session.relationship.persistence_mismatch.invalid",
    ),
    true,
  );

  const forkIssues = validateRahEvent(
    buildSessionCreatedEvent({
      relationship: {
        parentSessionId: "parent-session",
        kind: "fork",
        workspaceMode: "shared",
        persistence: "ephemeral",
      },
    }),
  );
  assert.equal(
    forkIssues.some(
      (issue) => issue.code === "session.relationship.persistence_mismatch.invalid",
    ),
    true,
  );

  const forkLifecycleIssues = validateRahEvent(
    buildSessionCreatedEvent({
      relationship: {
        parentSessionId: "parent-session",
        kind: "fork",
        workspaceMode: "shared",
        persistence: "persistent",
        sideState: "completed",
      },
    }),
  );
  assert.equal(
    forkLifecycleIssues.some(
      (issue) => issue.code === "session.relationship.fork_side_state.invalid",
    ),
    true,
  );
});

test("Side lifecycle and close disposition events enforce canonical states", () => {
  const base = {
    id: "evt-side-state",
    seq: 1,
    ts: "2026-04-29T00:00:00.000Z",
    sessionId: "session-side",
    source: { provider: "system", channel: "system", authority: "authoritative" },
  } as const;
  const validStateIssues = validateRahEvent({
    ...base,
    type: "session.side.state.changed",
    payload: { state: "cleanup_failed", detail: "unsubscribe failed" },
  });
  assert.equal(validStateIssues.some((issue) => issue.severity === "error"), false);

  const invalidStateIssues = validateRahEvent({
    ...base,
    type: "session.side.state.changed",
    payload: { state: "done" },
  } as unknown as Parameters<typeof validateRahEvent>[0]);
  assert.equal(
    invalidStateIssues.some((issue) => issue.code === "session.side.state.invalid"),
    true,
  );

  const validCloseIssues = validateRahEvent({
    ...base,
    type: "session.closed",
    payload: { disposition: "parent_closed" },
  });
  assert.equal(validCloseIssues.some((issue) => issue.severity === "error"), false);

  const invalidCloseIssues = validateRahEvent({
    ...base,
    type: "session.closed",
    payload: { disposition: "expired" },
  } as unknown as Parameters<typeof validateRahEvent>[0]);
  assert.equal(
    invalidCloseIssues.some((issue) => issue.code === "session.closed.disposition.invalid"),
    true,
  );
});

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

test("session events reject the removed terminal launch source", () => {
  const issues = validateRahEvent(
    buildSessionCreatedEvent({ launchSource: "terminal" }),
  );
  assert.equal(
    issues.some((issue) => issue.code === "session.launch_source.invalid"),
    true,
  );
});

test("session events accept tmux mux metadata", () => {
  const issues = validateRahEvent(
    buildSessionCreatedEvent({
      liveBackend: "tui_mux",
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

test("assistant timeline messages accept only canonical message phases", () => {
  const baseEvent = {
    id: "evt-assistant-phase",
    seq: 1,
    ts: "2026-07-10T00:00:00.000Z",
    sessionId: "session-1",
    type: "timeline.item.added" as const,
    source: { provider: "codex" as const, channel: "structured_persisted" as const, authority: "authoritative" as const },
  };
  const valid = validateRahEvent({
    ...baseEvent,
    payload: {
      item: { kind: "assistant_message", text: "Working", phase: "commentary" },
    },
  });
  assert.equal(valid.some((issue) => issue.severity === "error"), false);

  const invalid = validateRahEvent({
    ...baseEvent,
    payload: {
      item: { kind: "assistant_message", text: "Working", phase: "thinking" },
    },
  } as never);
  assert.equal(
    invalid.some((issue) => issue.code === "timeline.assistant_phase.invalid"),
    true,
  );
});

test("assistant timeline messages validate ordered interactive visual content", () => {
  const baseEvent = {
    id: "evt-assistant-visual",
    seq: 1,
    ts: "2026-07-29T00:00:00.000Z",
    sessionId: "session-1",
    type: "timeline.item.added" as const,
    source: {
      provider: "codex" as const,
      channel: "structured_persisted" as const,
      authority: "authoritative" as const,
    },
  };
  const valid = validateRahEvent({
    ...baseEvent,
    payload: {
      item: {
        kind: "assistant_message",
        text: "Before\n\nAfter",
        content: [
          { kind: "text", text: "Before" },
          {
            kind: "visual",
            artifact: {
              id: "curve.html",
              format: "interactive_html",
              mimeType: "text/html",
              label: "Curve",
            },
          },
          { kind: "text", text: "After" },
        ],
      },
    },
  });
  assert.equal(valid.some((issue) => issue.severity === "error"), false);

  const invalid = validateRahEvent({
    ...baseEvent,
    payload: {
      item: {
        kind: "assistant_message",
        text: "",
        content: [
          {
            kind: "visual",
            artifact: {
              id: "",
              format: "png",
              mimeType: "image/png",
            },
          },
        ],
      },
    },
  } as never);
  assert.equal(
    invalid.some((issue) => issue.code === "timeline.visual_artifact_id.invalid"),
    true,
  );
  assert.equal(
    invalid.some((issue) => issue.code === "timeline.visual_artifact_format.invalid"),
    true,
  );
  assert.equal(
    invalid.some((issue) => issue.code === "timeline.visual_artifact_mime.invalid"),
    true,
  );
});

test("system timeline messages accept only canonical placement scopes", () => {
  const baseEvent = {
    id: "evt-system-presentation",
    seq: 1,
    ts: "2026-07-10T00:00:00.000Z",
    sessionId: "session-1",
    type: "timeline.item.added" as const,
    source: {
      provider: "codex" as const,
      channel: "structured_persisted" as const,
      authority: "authoritative" as const,
    },
  };
  const valid = validateRahEvent({
    ...baseEvent,
    payload: {
      item: {
        kind: "system",
        text: "Conversation interrupted before this tool completed.",
        placement: "process",
      },
    },
  });
  assert.equal(valid.some((issue) => issue.severity === "error"), false);

  const invalid = validateRahEvent({
    ...baseEvent,
    payload: {
      item: {
        kind: "system",
        text: "Conversation interrupted before this tool completed.",
        placement: "before_header",
      },
    },
  } as never);
  assert.equal(
    invalid.some(
      (issue) => issue.code === "timeline.system.placement.invalid",
    ),
    true,
  );
});
