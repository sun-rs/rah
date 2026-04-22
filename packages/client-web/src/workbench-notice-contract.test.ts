import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { SessionSummary } from "@rah/runtime-protocol";
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
  });
});
