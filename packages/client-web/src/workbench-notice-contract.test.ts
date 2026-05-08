import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { NativeTuiDiagnostic, SessionSummary } from "@rah/runtime-protocol";
import { initialHistorySyncState, type SessionProjection } from "./types";
import { deriveWorkbenchNoticeState } from "./workbench-notice-contract";

function summary(args?: Partial<SessionSummary["session"]>): SessionSummary {
  return {
    session: {
      id: "session-1",
      provider: "codex",
      launchSource: "web",
      cwd: "/workspace/rah",
      rootDir: "/workspace/rah",
      runtimeState: "running",
      ptyId: "pty-1",
      capabilities: {
        liveAttach: true,
        structuredTimeline: true,
        livePermissions: true,
        contextUsage: true,
        resumeByProvider: true,
        listProviderSessions: true,
        steerInput: true,
        queuedInput: false,
        modelSwitch: false,
        planMode: false,
        subagents: false,
      },
      createdAt: "2026-04-15T00:00:00.000Z",
      updatedAt: "2026-04-15T00:00:00.000Z",
      ...args,
    },
    attachedClients: [],
    controlLease: { sessionId: "session-1" },
  };
}

function projection(summaryValue: SessionSummary): SessionProjection {
  return {
    summary: summaryValue,
    feed: [],
    events: [],
    lastSeq: 0,
    history: initialHistorySyncState(),
  };
}

function nativeDiagnostic(
  args?: Partial<NativeTuiDiagnostic>,
): NativeTuiDiagnostic {
  return {
    id: "native-tui:session-1:process_exited",
    sessionId: "session-1",
    provider: "codex",
    kind: "process_exited",
    severity: "warning",
    status: "active",
    message: "Native TUI process exited before the session was closed.",
    cwd: "/workspace/rah",
    createdAt: "2026-05-03T00:00:00.000Z",
    updatedAt: "2026-05-03T00:00:00.000Z",
    ...args,
  };
}

describe("workbench notice contract", () => {
  test("derives interaction notice for read-only replay sessions", () => {
    const state = deriveWorkbenchNoticeState({
      selectedSummary: summary({
        providerSessionId: "provider-1",
        capabilities: {
          ...summary().session.capabilities,
          steerInput: false,
          livePermissions: false,
        },
      }),
      selectedProjection: null,
      error: null,
    });

    assert.deepEqual(state.interactionNotice, {
      tone: "info",
      message: "History only. Claim control for live input and approvals.",
    });
  });

  test("derives terminal-control notice for terminal-owned running turns", () => {
    const state = deriveWorkbenchNoticeState({
      selectedSummary: {
        ...summary({
          provider: "claude",
          launchSource: "terminal",
          runtimeState: "running",
        }),
        controlLease: {
          sessionId: "session-1",
          holderClientId: "terminal-surface-1",
          holderKind: "terminal",
        },
      },
      selectedProjection: projection(summary()),
      error: null,
    });

    assert.deepEqual(state.interactionNotice, {
      tone: "info",
      message: "Terminal is handling this turn. Web can observe it, but can't interrupt it.",
    });
  });

  test("derives warning notice for stopped native TUI sessions", () => {
    const state = deriveWorkbenchNoticeState({
      selectedSummary: summary({
        liveBackend: "native_tui",
        runtimeState: "stopped",
        nativeTui: {
          terminalId: "session-1",
          viewAvailable: true,
        },
      }),
      selectedProjection: projection(summary()),
      error: null,
    });

    assert.deepEqual(state.interactionNotice, {
      tone: "warning",
      message:
        "Native TUI process is stopped. Archive this session or resume it from history to continue.",
    });
  });

  test("derives warning notice when native TUI has an unsent local draft", () => {
    const state = deriveWorkbenchNoticeState({
      selectedSummary: summary({
        liveBackend: "native_tui",
        nativeTui: {
          terminalId: "session-1",
          viewAvailable: true,
          promptState: "prompt_dirty",
        },
      }),
      selectedProjection: projection(summary()),
      error: null,
    });

    assert.deepEqual(state.interactionNotice, {
      tone: "warning",
      message:
        "Native TUI has an unsent local draft. Chat input will queue until the TUI prompt is clear.",
    });
  });

  test("derives queued input notice before the generic dirty-prompt notice", () => {
    const state = deriveWorkbenchNoticeState({
      selectedSummary: summary({
        liveBackend: "native_tui",
        nativeTui: {
          terminalId: "session-1",
          viewAvailable: true,
          promptState: "prompt_dirty",
          queuedInputCount: 2,
        },
      }),
      selectedProjection: projection(summary()),
      error: null,
    });

    assert.deepEqual(state.interactionNotice, {
      tone: "info",
      message: "2 Chat messages queued. It will send after the TUI prompt is clear.",
    });
  });

  test("prioritizes active native TUI diagnostics on the selected session", () => {
    const state = deriveWorkbenchNoticeState({
      selectedSummary: summary({
        liveBackend: "native_tui",
        runtimeState: "stopped",
        nativeTui: {
          terminalId: "session-1",
          viewAvailable: true,
        },
      }),
      selectedProjection: projection(summary()),
      nativeTuiDiagnostics: [
        nativeDiagnostic({
          kind: "mirror_source_missing",
          message: "Chat mirror source is not available yet.",
        }),
      ],
      error: null,
    });

    assert.deepEqual(state.interactionNotice, {
      tone: "warning",
      message: "Chat mirror: Chat mirror source is not available yet.",
    });
  });

  test("derives history loading and error notices from projection history state", () => {
    const loadingProjection: SessionProjection = {
      ...projection(summary({ providerSessionId: "provider-1" })),
      history: {
        ...initialHistorySyncState(),
        phase: "loading",
      },
    };

    assert.deepEqual(
      deriveWorkbenchNoticeState({
        selectedSummary: loadingProjection.summary,
        selectedProjection: loadingProjection,
        error: null,
      }).historyNotice,
      {
        tone: "info",
        message: "Syncing session history…",
      },
    );

    const errorProjection: SessionProjection = {
      ...projection(summary({ providerSessionId: "provider-1" })),
      history: {
        ...initialHistorySyncState(),
        phase: "error",
        lastError: "network timeout",
      },
    };

    assert.deepEqual(
      deriveWorkbenchNoticeState({
        selectedSummary: errorProjection.summary,
        selectedProjection: errorProjection,
        error: null,
      }).historyNotice,
      {
        tone: "warning",
        message: "History sync failed: network timeout",
      },
    );
  });

  test("derives global error descriptor from workbench error text", () => {
    const state = deriveWorkbenchNoticeState({
      selectedSummary: summary(),
      selectedProjection: projection(summary()),
      error: "Events socket failed",
    });

    assert.equal(state.errorDescriptor?.title, "Connection issue");
    assert.equal(state.errorDescriptor?.primaryAction, "refresh");
    assert.equal(state.errorDescriptor?.primaryLabel, "Reconnect");
  });
});
