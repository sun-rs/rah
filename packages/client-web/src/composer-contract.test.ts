import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SessionSummary } from "@rah/runtime-protocol";
import {
  COMPOSER_LAYOUT,
  EMPTY_STATE_COMPOSER_LAYOUT,
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
  test("derives an implicit-resume composer for unarchived read-only replay sessions", () => {
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
      kind: "compose",
      showStopButton: false,
      resumeOnSend: true,
    });
  });

  test("keeps archived history read-only", () => {
    const surface = deriveComposerSurface({
      selectedSummary: summary({
        providerSessionId: "provider-1",
        capabilities: {
          ...summary().session.capabilities,
          steerInput: false,
          livePermissions: false,
        },
      }),
      historyArchived: true,
      hasControl: false,
      isGenerating: false,
      pendingSessionAction: null,
    });

    assert.deepEqual(surface, { kind: "unavailable" });
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

  test("derives resume surface when input is possible but control is missing", () => {
    const surface = deriveComposerSurface({
      selectedSummary: summary(),
      hasControl: false,
      isGenerating: false,
      pendingSessionAction: null,
    });

    assert.deepEqual(surface, {
      kind: "claim_control",
      actionLabel: "Resume",
      actionPending: false,
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
    assert.match(
      COMPOSER_LAYOUT.stopWrapperClassName,
      /h-10 w-10 md:h-9 md:w-9 lg:h-8 lg:w-8/,
    );
    assert.match(
      COMPOSER_LAYOUT.sendButtonClassName,
      /h-10 w-10 md:h-9 md:w-9 lg:h-8 lg:w-8/,
    );
    assert.match(COMPOSER_LAYOUT.stopWarningButtonClassName, /inset-0/);
    assert.doesNotMatch(
      COMPOSER_LAYOUT.stopWarningButtonClassName,
      /inset-\[3px\]/,
    );
  });

  test("keeps composer workspace selection separate from sidebar workspace add", () => {
    const composerSource = readSource(
      "./components/workbench/panes/NewSessionComposer.tsx",
    );
    const emptyPaneSource = readSource(
      "./components/workbench/panes/WorkbenchEmptyPane.tsx",
    );
    const appSource = readSource("./App.tsx");

    assert.match(composerSource, /onChooseNewWorkspace/);
    assert.doesNotMatch(composerSource, /onAddWorkspace/);
    assert.match(emptyPaneSource, /onChooseNewWorkspace/);
    assert.match(appSource, /pendingNewSessionWorkspaceDir/);
    assert.match(
      appSource,
      /availableWorkspaceDir: emptyStateAvailableWorkspaceDir/,
    );
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

  test("reflects pending live resume actions and keeps history on the composer", () => {
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
        actionLabel: "Resuming…",
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
          kind: "resume_history",
          sessionId: "session-1",
        },
      }),
      {
        kind: "compose",
        showStopButton: false,
        resumeOnSend: true,
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
    assert.match(
      COMPOSER_LAYOUT.composeGridWithoutStopClassName,
      /\bgap-1\.5\b/,
    );
    assert.match(
      COMPOSER_LAYOUT.composeGridWithStopClassName,
      /grid-cols-\[auto_auto_1fr_auto_auto\]/,
    );
    assert.match(COMPOSER_LAYOUT.composeGridWithStopClassName, /\bgap-1\.5\b/);
    assert.equal(COMPOSER_LAYOUT.controlsGapClassName, "gap-1.5 md:gap-2");
    assert.match(COMPOSER_LAYOUT.stopSpinnerClassName, /animate-\[spin_/);
    assert.match(COMPOSER_LAYOUT.stopButtonClassName, /inset-\[3px\]/);
    assert.match(COMPOSER_LAYOUT.stopWarningButtonClassName, /amber/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\bblock\b/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\bmin-w-0\b/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\bmax-w-full\b/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\boverflow-x-hidden\b/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\brah-scroll-textarea\b/);
    assert.doesNotMatch(
      COMPOSER_LAYOUT.textareaClassName,
      /\brah-scroll-panel-y\b/,
    );
    assert.match(COMPOSER_LAYOUT.textareaClassName, /min-h-10/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\btext-base\b/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\bleading-6\b/);
    assert.match(
      COMPOSER_LAYOUT.textareaClassName,
      /placeholder:text-\[var\(--app-hint\)\]/,
    );
    assert.match(COMPOSER_LAYOUT.textareaClassName, /placeholder:opacity-60/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /focus:outline-none/);
    assert.doesNotMatch(COMPOSER_LAYOUT.textareaClassName, /focus:ring-/);
    assert.match(EMPTY_STATE_COMPOSER_LAYOUT.attachButtonClassName, /h-10/);
    assert.match(EMPTY_STATE_COMPOSER_LAYOUT.sendButtonClassName, /h-10/);
    assert.match(
      EMPTY_STATE_COMPOSER_LAYOUT.leftControlsClassName,
      /\bgap-1\b/,
    );
    assert.match(
      EMPTY_STATE_COMPOSER_LAYOUT.leftControlsClassName,
      /\boverflow-visible\b/,
    );
    assert.equal(
      EMPTY_STATE_COMPOSER_LAYOUT.textareaWrapperClassName,
      "max-w-full",
    );
    assert.match(
      EMPTY_STATE_COMPOSER_LAYOUT.textareaClassName,
      /min-h-\[7\.5rem\]/,
    );
    assert.match(
      EMPTY_STATE_COMPOSER_LAYOUT.textareaClassName,
      /focus:outline-none/,
    );
    assert.doesNotMatch(
      EMPTY_STATE_COMPOSER_LAYOUT.textareaClassName,
      /focus:ring-/,
    );
    assert.match(
      EMPTY_STATE_COMPOSER_LAYOUT.textareaContentClassName,
      /\bleading-6\b/,
    );
    assert.match(EMPTY_STATE_COMPOSER_LAYOUT.controlsRowClassName, /bottom-3/);
    assert.equal(shouldCompactEmptyStateSessionControls(null), true);
    assert.equal(shouldCompactEmptyStateSessionControls(619), true);
    assert.equal(shouldCompactEmptyStateSessionControls(620), false);
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
    assert.doesNotMatch(
      source,
      /el\.style\.height = `\\$\\{collapsedHeight\\}px`/,
    );
  });

  test("keeps provider, mode, plan, and model controls independently visible", () => {
    const source = readSource(
      "./components/workbench/panes/NewSessionComposer.tsx",
    );
    const providerSource = readSource("./components/ProviderSelector.tsx");
    const popoverSource = readSource("./components/SessionControlPopover.tsx");

    assert.match(source, /<SessionControlPopover/);
    assert.match(source, /<SessionModeControls/);
    assert.match(source, /<SessionModelControls/);
    assert.match(source, /<ProviderSelector/);
    assert.match(source, /ResizeObserver/);
    assert.doesNotMatch(source, /triggerTitle="New task settings"/);
    assert.doesNotMatch(source, /rah-new-session-settings-label/);
    assert.doesNotMatch(popoverSource, /<ProviderSelector/);
    assert.doesNotMatch(popoverSource, /mode="segmented"/);
    assert.match(providerSource, /max-w-none[\s\S]*sm:max-w-\[24rem\]/);
    assert.match(
      providerSource,
      /translateX\(\$\{selectedOptionIndex \* 100\}%\)/,
    );
    assert.match(providerSource, /hidden truncate sm:inline/);
  });

  test("keeps live working controls read only and history resume controls editable", () => {
    const source = readSource("./components/SessionControlPopover.tsx");
    const selectedPaneSource = readSource(
      "./components/workbench/panes/WorkbenchSelectedPane.tsx",
    );

    assert.match(source, /"Working configuration"/);
    assert.match(source, /"Session control"/);
    assert.match(source, /locked\s*\? "View working configuration"/);
    assert.match(
      source,
      /disabled=\{locked \|\| props\.disabled \|\| \(props\.modeDisabled \?\? false\)\}/,
    );
    assert.match(
      source,
      /disabled=\{locked \|\| props\.disabled \|\| \(props\.modelDisabled \?\? false\)\}/,
    );
    assert.doesNotMatch(
      source,
      /Session controls are locked while this session is busy/,
    );
    assert.match(
      selectedPaneSource,
      /const resumeSessionControlPending =\s*props\.resumeModePending \|\| props\.sendPending \|\| composerActionPending;/,
    );
    assert.doesNotMatch(
      selectedPaneSource,
      /const resumeSessionControlPending =[\s\S]{0,160}(?:sessionControlBusy|modelChangePending)/,
    );
    assert.match(
      selectedPaneSource,
      /locked=\{!resumeOnSend && sessionControlBusy\}/,
    );
    assert.match(
      selectedPaneSource,
      /selectedModelId=\{[\s\S]*resumeOnSend[\s\S]*props\.selectedResumeModelId/,
    );
    assert.match(
      source,
      /props\.showModel && Boolean\(props\.modelCatalog \|\| props\.modelCatalogLoading \|\| props\.onOpen\)/,
    );
    assert.match(
      selectedPaneSource,
      /showModel=\{resumeOnSend \|\| showLiveModelControl\}/,
    );
    assert.doesNotMatch(
      selectedPaneSource,
      /resumeOnSend\s*\?\s*Boolean\(props\.modelCatalog \|\| props\.modelCatalogLoading\)/,
    );
    assert.doesNotMatch(selectedPaneSource, /lockedMessage=/);
  });

  test("keeps workspace selection inside the original composer control row", () => {
    const appSource = readSource("./App.tsx");
    const source = readSource(
      "./components/workbench/panes/NewSessionComposer.tsx",
    );
    const styles = readSource("./styles.css");
    const controlsStart = source.indexOf("ref={controlsRowRef}");
    const workspaceControl = source.indexOf(
      "props.workspaceDirs.length === 0",
      controlsStart,
    );
    const sessionControl = source.indexOf(
      "<SessionControlPopover",
      controlsStart,
    );

    assert.doesNotMatch(source, /NewSessionWorkspaceContext/);
    assert.match(source, /What would you like to build\?/);
    assert.doesNotMatch(source, /workspaceStripTriggerClassName/);
    assert.doesNotMatch(source, /className="relative z-0 -mb-3"/);
    assert.ok(controlsStart >= 0);
    assert.ok(workspaceControl > controlsStart);
    assert.ok(sessionControl > workspaceControl);
    assert.match(source, /EMPTY_STATE_COMPOSER_LAYOUT\.pillClassName/);
    assert.match(source, /shouldUseIconOnlyEmptyStateWorkspace/);
    assert.match(source, /<Folder size=\{iconOnlyWorkspace \? 18 : 12\}/);
    assert.match(source, /<ChevronDown[\s\S]*size=\{11\}/);
    assert.match(source, /<ProviderSelector/);
    assert.match(source, /<OverlayScrollArea/);
    assert.match(source, /Add workspace…/);
    assert.match(source, /<WorkspacePicker/);
    assert.match(source, /<SessionControlPopover/);
    assert.match(source, /<SessionModeControls/);
    assert.match(source, /<SessionModelControls/);
    assert.match(
      source,
      /<SessionControlPopover[\s\S]*<SessionModeControls[\s\S]*<SessionModelControls[\s\S]*aria-label="Start session"/,
    );
    assert.match(styles, /\.rah-marquee\s*\{/);
    assert.doesNotMatch(styles, /rah-new-session-workspace-trigger/);
    assert.doesNotMatch(styles, /rah-new-session-workspace-menu/);
    assert.doesNotMatch(styles, /rah-new-session-composer/);
    assert.match(appSource, /reason:\s*"new-session-visible"/);
    assert.match(
      appSource,
      /primaryPaneState\.kind !== "empty"[\s\S]*background:\s*true[\s\S]*reason:\s*"new-session-visible"/,
    );
  });

  test("compacts empty-state controls in ordered stages", () => {
    assert.equal(shouldCompactEmptyStateSessionControls(null), true);
    assert.equal(shouldCompactEmptyStateSessionControls(619), true);
    assert.equal(shouldCompactEmptyStateSessionControls(620), false);
    assert.equal(shouldUseIconOnlyEmptyStateWorkspace(null), false);
    assert.equal(shouldUseIconOnlyEmptyStateWorkspace(379), true);
    assert.equal(shouldUseIconOnlyEmptyStateWorkspace(380), false);
    assert.equal(shouldHideEmptyStateSessionControl(null), false);
    assert.equal(shouldHideEmptyStateSessionControl(359), true);
    assert.equal(shouldHideEmptyStateSessionControl(360), false);
  });

  test("styles uploaded attachments as working-tone pills", () => {
    const source = readSource("./components/ComposerAttachmentBadge.tsx");

    assert.match(source, /border-2/);
    assert.match(source, /border-sky-500\/35/);
    assert.match(source, /bg-sky-500\/10/);
    assert.match(source, /rounded-lg/);
    assert.match(source, /overflow-x-auto/);
    assert.match(source, /relative z-0/);
    assert.match(source, /h-4 w-4/);
    assert.match(source, /rounded-full bg-sky-100/);
    assert.match(source, /<X size=\{9\}/);
    assert.doesNotMatch(source, /border-primary/);
    assert.doesNotMatch(source, /bg-primary/);
    assert.doesNotMatch(source, /text-primary-foreground/);
  });

  test("stacks PWA attachments and exposes an explicit upload progress state", () => {
    const badgeSource = readSource("./components/ComposerAttachmentBadge.tsx");
    const controlSource = readSource(
      "./components/ComposerAttachmentControl.tsx",
    );
    const newSessionSource = readSource(
      "./components/workbench/panes/NewSessionComposer.tsx",
    );
    const selectedSessionSource = readSource(
      "./components/workbench/panes/WorkbenchSelectedPane.tsx",
    );

    assert.match(badgeSource, /layout\?: "row" \| "stack"/);
    assert.match(badgeSource, /layout === "stack"/);
    assert.match(badgeSource, /flex-col/);
    assert.match(badgeSource, /overflow-y-auto/);
    assert.match(controlSource, /LoaderCircle/);
    assert.match(controlSource, /animate-spin/);
    assert.match(controlSource, /aria-busy=\{uploadInProgress\}/);
    assert.match(controlSource, /Uploading attachments/);
    assert.match(
      newSessionSource,
      /layout=\{\s*isPwaDisplayMode && draftAttachments\.length > 1\s*\? "stack"\s*: "row"\s*\}/,
    );
    assert.match(
      selectedSessionSource,
      /layout=\{\s*isPwaDisplayMode && draftAttachments\.length > 1\s*\? "stack"\s*: "row"\s*\}/,
    );
  });

  test("keeps the mobile attachment menu platform-neutral and preserves workspace references", () => {
    const source = readSource("./components/ComposerAttachmentControl.tsx");

    assert.match(source, />Reference workspace file</);
    assert.match(source, />Choose from device</);
    assert.match(source, /multiple/);
    assert.match(source, /isPwa \|\| compactTouchViewport/);
    assert.match(source, /htmlFor=\{deviceInputId\}/);
    assert.match(source, /className="sr-only"/);
    assert.doesNotMatch(source, />Take photo</);
    assert.doesNotMatch(source, /capture="environment"/);
    assert.doesNotMatch(source, /\.current\?\.click\(\)/);
    assert.doesNotMatch(source, /Mac|macOS/);
  });

  test("reuses the unified attachment control across new, session, and Canvas composers", () => {
    const newSessionSource = readSource(
      "./components/workbench/panes/NewSessionComposer.tsx",
    );
    const selectedSessionSource = readSource(
      "./components/workbench/panes/WorkbenchSelectedPane.tsx",
    );
    const canvasSessionSource = readSource(
      "./components/workbench/canvas/CanvasSessionPane.tsx",
    );
    const canvasNewSessionSource = readSource(
      "./components/workbench/canvas/CanvasNewSessionPane.tsx",
    );

    assert.match(newSessionSource, /<ComposerAttachmentControl/);
    assert.match(selectedSessionSource, /<ComposerAttachmentControl/);
    assert.match(canvasSessionSource, /<WorkbenchSelectedPane/);
    assert.match(
      canvasSessionSource,
      /onOpenFileReference=\{\(\) => setFileReferenceOpen\(true\)\}/,
    );
    assert.match(canvasNewSessionSource, /<NewSessionComposer/);
    assert.match(
      canvasNewSessionSource,
      /onOpenFileReference=\{\(\) => setFileReferenceOpen\(true\)\}/,
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
        attachmentCount: 1,
        sendPending: false,
        nativeTuiPromptState: "prompt_clean",
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
