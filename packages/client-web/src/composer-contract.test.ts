import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { SessionSummary } from "@rah/runtime-protocol";
import {
  COMPOSER_LAYOUT,
  EMPTY_STATE_COMPOSER_LAYOUT,
  deriveComposerSurface,
} from "./composer-contract";

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

describe("composer contract", () => {
  test("derives history claim surface for read-only replay sessions", () => {
    const surface = deriveComposerSurface({
      selectedSummary: summary({
        providerSessionId: "provider-1",
        capabilities: {
          ...summary().session.capabilities,
          steerInput: false,
          livePermissions: false,
        },
      }),
      hasControl: false,
      isGenerating: false,
      pendingSessionAction: null,
    });

    assert.deepEqual(surface, {
      kind: "history_claim",
      actionLabel: "Claim control",
      actionPending: false,
    });
  });

  test("derives unavailable surface for observe-only sessions", () => {
    const surface = deriveComposerSurface({
      selectedSummary: summary({
        capabilities: {
          ...summary().session.capabilities,
          steerInput: false,
          livePermissions: true,
        },
      }),
      hasControl: false,
      isGenerating: false,
      pendingSessionAction: null,
    });

    assert.deepEqual(surface, { kind: "unavailable" });
  });

  test("derives claim_control surface when input is possible but control is missing", () => {
    const surface = deriveComposerSurface({
      selectedSummary: summary(),
      hasControl: false,
      isGenerating: false,
      pendingSessionAction: null,
    });

    assert.deepEqual(surface, {
      kind: "claim_control",
      actionLabel: "Claim control",
      actionPending: false,
    });
  });

  test("derives compose surface and preserves stop visibility while generating", () => {
    assert.deepEqual(
      deriveComposerSurface({
        selectedSummary: summary(),
        hasControl: true,
        isGenerating: false,
        pendingSessionAction: null,
      }),
      { kind: "compose", showStopButton: false },
    );

    assert.deepEqual(
      deriveComposerSurface({
        selectedSummary: summary(),
        hasControl: true,
        isGenerating: true,
        pendingSessionAction: null,
      }),
      { kind: "compose", showStopButton: true },
    );
  });

  test("reflects pending claim actions in button label and disabled state", () => {
    assert.deepEqual(
      deriveComposerSurface({
        selectedSummary: summary(),
        hasControl: false,
        isGenerating: false,
        pendingSessionAction: {
          kind: "claim_control",
          sessionId: "session-1",
        },
      }),
      {
        kind: "claim_control",
        actionLabel: "Claiming…",
        actionPending: true,
      },
    );

    assert.deepEqual(
      deriveComposerSurface({
        selectedSummary: summary({
          providerSessionId: "provider-1",
          capabilities: {
            ...summary().session.capabilities,
            steerInput: false,
            livePermissions: false,
          },
        }),
        hasControl: false,
        isGenerating: false,
        pendingSessionAction: {
          kind: "claim_history",
          sessionId: "session-1",
        },
      }),
      {
        kind: "history_claim",
        actionLabel: "Claiming…",
        actionPending: true,
      },
    );
  });

  test("keeps composer layout constants centralized", () => {
    assert.match(COMPOSER_LAYOUT.roundSecondaryButtonClassName, /h-11/);
    assert.match(COMPOSER_LAYOUT.roundPrimaryButtonClassName, /h-11/);
    assert.match(
      COMPOSER_LAYOUT.composeGridWithoutStopClassName,
      /grid-cols-\[2\.75rem_minmax\(0,1fr\)_2\.75rem\]/,
    );
    assert.match(COMPOSER_LAYOUT.composeGridWithoutStopClassName, /\bgap-2\b/);
    assert.match(
      COMPOSER_LAYOUT.composeGridWithStopClassName,
      /grid-cols-\[2\.75rem_minmax\(0,1fr\)_2\.75rem_2\.75rem\]/,
    );
    assert.match(COMPOSER_LAYOUT.composeGridWithStopClassName, /\bgap-2\b/);
    assert.equal(
      COMPOSER_LAYOUT.controlsGapClassName,
      "gap-2 md:gap-3",
    );
    assert.match(COMPOSER_LAYOUT.stopSpinnerClassName, /animate-\[spin_/);
    assert.match(COMPOSER_LAYOUT.stopButtonClassName, /inset-\[3px\]/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\bblock\b/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\bh-11\b/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /min-h-11/);
    assert.equal(
      EMPTY_STATE_COMPOSER_LAYOUT.roundSecondaryButtonClassName,
      COMPOSER_LAYOUT.roundSecondaryButtonClassName,
    );
    assert.equal(
      EMPTY_STATE_COMPOSER_LAYOUT.roundPrimaryButtonClassName,
      COMPOSER_LAYOUT.roundPrimaryButtonClassName,
    );
    assert.match(EMPTY_STATE_COMPOSER_LAYOUT.leftControlsClassName, /\bgap-2\b/);
    assert.match(EMPTY_STATE_COMPOSER_LAYOUT.textareaClassName, /min-h-\[120px\]/);
    assert.match(EMPTY_STATE_COMPOSER_LAYOUT.controlsRowClassName, /bottom-3/);
    assert.match(EMPTY_STATE_COMPOSER_LAYOUT.workspaceTriggerClassName, /h-11/);
    assert.equal(
      COMPOSER_LAYOUT.bottomPaddingStyle.paddingBottom,
      "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)",
    );
  });
});
