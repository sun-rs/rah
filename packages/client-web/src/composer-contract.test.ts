import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SessionSummary } from "@rah/runtime-protocol";
import {
  COMPOSER_LAYOUT,
  EMPTY_STATE_COMPOSER_LAYOUT,
  EMPTY_STATE_EXPANDED_CONTROLS_MIN_WIDTH_PX,
  EMPTY_STATE_HIDE_SESSION_CONTROL_MIN_WIDTH_PX,
  EMPTY_STATE_ICON_WORKSPACE_MIN_WIDTH_PX,
  canSubmitComposerInput,
  deriveComposerSurface,
  shouldCompactEmptyStateSessionControls,
  shouldHideEmptyStateSessionControl,
  shouldUseIconOnlyEmptyStateWorkspace,
} from "./composer-contract";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

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
      actionLabel: "Resume",
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

  test("allows terminal-launched running sessions to compose without an explicit control claim", () => {
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
      stopTitle: "Interrupt the native TUI turn from Web.",
    });
  });

  test("allows native local-server Chat to compose even when TUI control belongs elsewhere", () => {
    const surface = deriveComposerSurface({
      selectedSummary: summary({
        launchSource: "web",
        liveBackend: "native_local_server",
      }),
      hasControl: false,
      isGenerating: true,
      pendingSessionAction: null,
    });

    assert.deepEqual(surface, {
      kind: "compose",
      showStopButton: true,
      stopTitle: "Interrupt the native TUI turn from Web.",
    });
  });

  test("shows Claude native TUI Esc control as best-effort instead of generating stop", () => {
    const surface = deriveComposerSurface({
      selectedSummary: summary({
        provider: "claude",
        liveBackend: "tui_mux",
        nativeTui: {
          terminalId: "terminal-claude-1",
          viewAvailable: true,
          promptState: "prompt_clean",
          queuedInputCount: 0,
        },
      }),
      hasControl: false,
      isGenerating: false,
      pendingSessionAction: null,
    });

    assert.equal(surface.kind, "compose");
    if (surface.kind !== "compose") {
      return;
    }
    assert.equal(surface.showStopButton, true);
    assert.equal(surface.stopTone, "warning");
    assert.equal(surface.stopSpinner, false);
    assert.equal(surface.stopAriaLabel, "Send Esc to Claude TUI");
    assert.match(surface.stopTitle ?? "", /best-effort/);
  });

  test("shows Gemini native TUI Esc control as best-effort instead of generating stop", () => {
    const surface = deriveComposerSurface({
      selectedSummary: summary({
        provider: "gemini",
        liveBackend: "tui_mux",
        nativeTui: {
          terminalId: "terminal-gemini-1",
          viewAvailable: true,
          promptState: "agent_busy",
          queuedInputCount: 0,
        },
      }),
      hasControl: false,
      isGenerating: true,
      pendingSessionAction: null,
    });

    assert.equal(surface.kind, "compose");
    if (surface.kind !== "compose") {
      return;
    }
    assert.equal(surface.showStopButton, true);
    assert.equal(surface.stopTone, "warning");
    assert.equal(surface.stopSpinner, false);
    assert.equal(surface.stopAriaLabel, "Send Esc to Gemini TUI");
    assert.match(surface.stopTitle ?? "", /best-effort/);
  });

  test("shows Claude Esc control even before live backend and native TUI metadata are refreshed", () => {
    const surface = deriveComposerSurface({
      selectedSummary: summary({
        provider: "claude",
      }),
      hasControl: true,
      isGenerating: false,
      pendingSessionAction: null,
    });

    assert.equal(surface.kind, "compose");
    if (surface.kind !== "compose") {
      return;
    }
    assert.equal(surface.showStopButton, true);
    assert.equal(surface.stopTone, "warning");
    assert.equal(surface.stopSpinner, false);
  });

  test("sizes best-effort Esc controls to the same outer box as send", () => {
    assert.match(COMPOSER_LAYOUT.stopWrapperClassName, /h-10 w-10 md:h-9 md:w-9 lg:h-8 lg:w-8/);
    assert.match(COMPOSER_LAYOUT.sendButtonClassName, /h-10 w-10 md:h-9 md:w-9 lg:h-8 lg:w-8/);
    assert.match(COMPOSER_LAYOUT.stopWarningButtonClassName, /inset-0/);
    assert.doesNotMatch(COMPOSER_LAYOUT.stopWarningButtonClassName, /inset-\[3px\]/);
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
        actionLabel: "Resuming…",
        actionPending: true,
      },
    );
  });

  test("keeps composer layout constants centralized", () => {
    assert.match(COMPOSER_LAYOUT.attachButtonClassName, /h-10/);
    assert.match(COMPOSER_LAYOUT.settingsButtonClassName, /h-10/);
    assert.match(COMPOSER_LAYOUT.sendButtonClassName, /h-10/);
    assert.match(COMPOSER_LAYOUT.claimRowClassName, /h-10/);
    assert.match(COMPOSER_LAYOUT.claimRowClassName, /md:h-9/);
    assert.match(COMPOSER_LAYOUT.claimRowClassName, /lg:h-8/);
    assert.doesNotMatch(COMPOSER_LAYOUT.claimRowClassName, /\bpy-/);
    assert.match(COMPOSER_LAYOUT.claimButtonClassName, /w-\[6\.5rem\]/);
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
    assert.match(COMPOSER_LAYOUT.stopWarningButtonClassName, /amber/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\bblock\b/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\bmin-w-0\b/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\bmax-w-full\b/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\boverflow-x-hidden\b/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\brah-scroll-textarea\b/);
    assert.doesNotMatch(COMPOSER_LAYOUT.textareaClassName, /\brah-scroll-panel-y\b/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /min-h-10/);
    assert.match(EMPTY_STATE_COMPOSER_LAYOUT.attachButtonClassName, /h-10/);
    assert.match(EMPTY_STATE_COMPOSER_LAYOUT.sendButtonClassName, /h-10/);
    assert.match(EMPTY_STATE_COMPOSER_LAYOUT.leftControlsClassName, /\bgap-1\b/);
    assert.match(EMPTY_STATE_COMPOSER_LAYOUT.leftControlsClassName, /\boverflow-visible\b/);
    assert.equal(EMPTY_STATE_COMPOSER_LAYOUT.textareaWrapperClassName, "max-w-full");
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

  test("resizes the message composer before paint without live height churn", () => {
    const source = readSource("./components/TokenizedTextarea.tsx");

    assert.match(source, /useLayoutEffect/);
    assert.match(source, /measurementRef/);
    assert.match(source, /measureRequiredContentHeight/);
    assert.match(source, /measurement\.style\.height = "auto"/);
    assert.match(source, /HEIGHT_CHANGE_EPSILON_PX/);
    assert.match(source, /wrapperClassName/);
    assert.doesNotMatch(source, /queueMicrotask\(adjustHeight\)/);
    assert.doesNotMatch(source, /el\.style\.height = "auto"/);
    assert.doesNotMatch(source, /el\.style\.height = `\\$\\{collapsedHeight\\}px`/);
  });

  test("compacts empty-state session controls based on actual composer width", () => {
    assert.ok(
      EMPTY_STATE_HIDE_SESSION_CONTROL_MIN_WIDTH_PX < EMPTY_STATE_ICON_WORKSPACE_MIN_WIDTH_PX,
    );
    assert.ok(
      EMPTY_STATE_HIDE_SESSION_CONTROL_MIN_WIDTH_PX >= 176,
    );
    assert.ok(
      EMPTY_STATE_HIDE_SESSION_CONTROL_MIN_WIDTH_PX <= 200,
    );
    assert.ok(
      EMPTY_STATE_ICON_WORKSPACE_MIN_WIDTH_PX < EMPTY_STATE_EXPANDED_CONTROLS_MIN_WIDTH_PX,
    );

    assert.equal(shouldCompactEmptyStateSessionControls(null), true);
    assert.equal(
      shouldCompactEmptyStateSessionControls(EMPTY_STATE_EXPANDED_CONTROLS_MIN_WIDTH_PX - 1),
      true,
    );
    assert.equal(
      shouldCompactEmptyStateSessionControls(EMPTY_STATE_EXPANDED_CONTROLS_MIN_WIDTH_PX),
      false,
    );

    assert.equal(shouldUseIconOnlyEmptyStateWorkspace(null), false);
    assert.equal(
      shouldUseIconOnlyEmptyStateWorkspace(EMPTY_STATE_ICON_WORKSPACE_MIN_WIDTH_PX - 1),
      true,
    );
    assert.equal(
      shouldUseIconOnlyEmptyStateWorkspace(EMPTY_STATE_ICON_WORKSPACE_MIN_WIDTH_PX),
      false,
    );

    assert.equal(shouldHideEmptyStateSessionControl(null), false);
    assert.equal(
      shouldHideEmptyStateSessionControl(EMPTY_STATE_HIDE_SESSION_CONTROL_MIN_WIDTH_PX - 1),
      true,
    );
    assert.equal(
      shouldHideEmptyStateSessionControl(EMPTY_STATE_HIDE_SESSION_CONTROL_MIN_WIDTH_PX),
      false,
    );
  });

  test("allows native TUI Chat composer submission while the provider prompt is dirty", () => {
    const composerSurface = {
      kind: "compose",
      showStopButton: false,
    } as const;

    assert.equal(
      canSubmitComposerInput({
        composerSurface,
        draft: "send this",
        sendPending: false,
        nativeTuiPromptState: "prompt_clean",
      }),
      true,
    );
    assert.equal(
      canSubmitComposerInput({
        composerSurface,
        draft: "send this",
        sendPending: false,
        nativeTuiPromptState: "prompt_dirty",
      }),
      true,
    );
    assert.equal(
      canSubmitComposerInput({
        composerSurface,
        draft: "   ",
        sendPending: false,
        nativeTuiPromptState: "prompt_clean",
      }),
      false,
    );
    assert.equal(
      canSubmitComposerInput({
        composerSurface,
        draft: "send this",
        sendPending: true,
        nativeTuiPromptState: "prompt_clean",
      }),
      true,
    );
    assert.equal(
      canSubmitComposerInput({
        composerSurface,
        draft: "send this",
        sendPending: true,
      }),
      false,
    );
  });
});
