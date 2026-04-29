import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { SessionSummary } from "@rah/runtime-protocol";
import {
  COMPOSER_LAYOUT,
  EMPTY_STATE_COMPOSER_LAYOUT,
  EMPTY_STATE_EXPANDED_CONTROLS_MIN_WIDTH_PX,
  deriveComposerSurface,
  shouldCompactEmptyStateSessionControls,
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

  test("allows terminal-launched live sessions to compose without an explicit control claim", () => {
    const surface = deriveComposerSurface({
      selectedSummary: summary({
        launchSource: "terminal",
      }),
      hasControl: false,
      isGenerating: true,
      pendingSessionAction: null,
    });

    assert.deepEqual(surface, {
      kind: "compose",
      showStopButton: true,
      stopDisabled: true,
      stopTitle: "Terminal is handling this turn. Web can observe it, but can't interrupt it.",
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
    assert.match(COMPOSER_LAYOUT.attachButtonClassName, /h-10/);
    assert.match(COMPOSER_LAYOUT.settingsButtonClassName, /h-10/);
    assert.match(COMPOSER_LAYOUT.sendButtonClassName, /h-10/);
    assert.match(
      COMPOSER_LAYOUT.composeGridWithoutStopClassName,
      /grid-cols-\[auto_auto_1fr_auto\]/,
    );
    assert.match(COMPOSER_LAYOUT.composeGridWithoutStopClassName, /\bgap-1\.5\b/);
    assert.match(
      COMPOSER_LAYOUT.composeGridWithStopClassName,
      /grid-cols-\[auto_auto_1fr_auto_auto\]/,
    );
    assert.match(COMPOSER_LAYOUT.composeGridWithStopClassName, /\bgap-1\.5\b/);
    assert.equal(
      COMPOSER_LAYOUT.controlsGapClassName,
      "gap-1.5 md:gap-2",
    );
    assert.match(COMPOSER_LAYOUT.stopSpinnerClassName, /animate-\[spin_/);
    assert.match(COMPOSER_LAYOUT.stopButtonClassName, /inset-\[3px\]/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\bblock\b/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /min-h-10/);
    assert.match(EMPTY_STATE_COMPOSER_LAYOUT.attachButtonClassName, /h-10/);
    assert.match(EMPTY_STATE_COMPOSER_LAYOUT.sendButtonClassName, /h-10/);
    assert.match(EMPTY_STATE_COMPOSER_LAYOUT.leftControlsClassName, /\bgap-1\b/);
    assert.match(EMPTY_STATE_COMPOSER_LAYOUT.textareaClassName, /min-h-\[7\.5rem\]/);
    assert.match(EMPTY_STATE_COMPOSER_LAYOUT.controlsRowClassName, /bottom-3/);
    assert.match(EMPTY_STATE_COMPOSER_LAYOUT.configRowClassName, /\bgap-2\b/);
    assert.equal(
      COMPOSER_LAYOUT.bottomPaddingStyle.paddingBottom,
      "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)",
    );
    assert.equal(
      COMPOSER_LAYOUT.bottomPaddingStyle.paddingLeft,
      "max(0.75rem, env(safe-area-inset-left))",
    );
    assert.equal(
      COMPOSER_LAYOUT.bottomPaddingStyle.paddingRight,
      "max(0.75rem, env(safe-area-inset-right))",
    );
  });

  test("compacts empty-state session controls based on actual composer width", () => {
    assert.equal(shouldCompactEmptyStateSessionControls(null), true);
    assert.equal(
      shouldCompactEmptyStateSessionControls(EMPTY_STATE_EXPANDED_CONTROLS_MIN_WIDTH_PX - 1),
      true,
    );
    assert.equal(
      shouldCompactEmptyStateSessionControls(EMPTY_STATE_EXPANDED_CONTROLS_MIN_WIDTH_PX),
      false,
    );
  });
});
