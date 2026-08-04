import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SessionSummary } from "@rah/runtime-protocol";
import {
  COMPOSER_LAYOUT,
  COMPOSER_PLACEHOLDER,
  EMPTY_STATE_COMPOSER_LAYOUT,
  canSubmitComposerInput,
  deriveComposerSurface,
  shouldShowComposerStopAction,
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
  });

  test("uses one stable black-and-white primary action slot", () => {
    assert.match(
      COMPOSER_LAYOUT.primaryActionButtonClassName,
      /h-10 w-10 md:h-8 md:w-8 lg:h-7 lg:w-7/,
    );
    assert.match(COMPOSER_LAYOUT.primaryActionButtonClassName, /bg-primary/);
    assert.match(COMPOSER_LAYOUT.primaryActionButtonClassName, /text-primary-foreground/);
    assert.doesNotMatch(
      COMPOSER_LAYOUT.primaryActionButtonClassName,
      /app-danger|animate-\[spin_/,
    );
    assert.match(COMPOSER_LAYOUT.stopWarningActionButtonClassName, /amber/);
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

  test("replaces Stop with Send as soon as the working composer has new input", () => {
    const workingSurface = { kind: "compose", showStopButton: true } as const;

    assert.equal(
      shouldShowComposerStopAction({
        composerSurface: workingSurface,
        draft: "",
      }),
      true,
    );
    assert.equal(
      shouldShowComposerStopAction({
        composerSurface: workingSurface,
        draft: "next question",
      }),
      false,
    );
    assert.equal(
      shouldShowComposerStopAction({
        composerSurface: workingSurface,
        draft: "",
        attachmentCount: 1,
      }),
      false,
    );
    assert.equal(
      shouldShowComposerStopAction({
        composerSurface: { kind: "compose", showStopButton: false },
        draft: "",
      }),
      false,
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
    assert.match(COMPOSER_LAYOUT.attachButtonClassName, /text-\[var\(--app-fg\)\]/);
    assert.match(COMPOSER_LAYOUT.settingsButtonClassName, /text-\[var\(--app-fg\)\]/);
    assert.doesNotMatch(COMPOSER_LAYOUT.attachButtonClassName, /text-\[var\(--app-hint\)\]/);
    assert.doesNotMatch(COMPOSER_LAYOUT.settingsButtonClassName, /text-\[var\(--app-hint\)\]/);
    assert.match(COMPOSER_LAYOUT.primaryActionButtonClassName, /h-10/);
    assert.match(COMPOSER_LAYOUT.composeGridClassName, /\bflex-col\b/);
    assert.match(COMPOSER_LAYOUT.composeGridClassName, /\bgap-1\b/);
    assert.equal(COMPOSER_LAYOUT.controlsGapClassName, "gap-1.5");
    assert.doesNotMatch(COMPOSER_LAYOUT.primaryActionButtonClassName, /animate-\[spin_/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\bblock\b/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\bmin-w-0\b/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\bmax-w-full\b/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\boverflow-x-hidden\b/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\brah-scroll-textarea\b/);
    assert.doesNotMatch(
      COMPOSER_LAYOUT.textareaClassName,
      /\brah-scroll-panel-y\b/,
    );
    assert.match(COMPOSER_LAYOUT.textareaClassName, /min-h-\[2\.25rem\]/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\btext-base\b/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\bleading-6\b/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\bmd:text-sm\b/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\bmd:leading-5\b/);
    assert.match(COMPOSER_LAYOUT.composeGridClassName, /md:min-h-\[6\.25rem\]/);
    assert.match(COMPOSER_LAYOUT.composeGridClassName, /md:py-2/);
    assert.match(
      COMPOSER_LAYOUT.textareaClassName,
      /placeholder:text-\[var\(--app-hint\)\]/,
    );
    assert.match(COMPOSER_LAYOUT.textareaClassName, /placeholder:opacity-55/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /focus:outline-none/);
    assert.match(COMPOSER_LAYOUT.textareaClassName, /focus:ring-0/);
    assert.match(EMPTY_STATE_COMPOSER_LAYOUT.attachButtonClassName, /h-10/);
    assert.match(
      EMPTY_STATE_COMPOSER_LAYOUT.attachButtonClassName,
      /text-\[var\(--app-fg\)\]/,
    );
    assert.match(EMPTY_STATE_COMPOSER_LAYOUT.sendButtonClassName, /h-10/);
    assert.match(
      EMPTY_STATE_COMPOSER_LAYOUT.workspaceButtonClassName,
      /h-7/,
    );
    assert.match(
      EMPTY_STATE_COMPOSER_LAYOUT.workspaceButtonClassName,
      /max-w-\[12rem\]/,
    );
    assert.match(
      EMPTY_STATE_COMPOSER_LAYOUT.workspaceButtonClassName,
      /border-transparent/,
    );
    assert.match(
      EMPTY_STATE_COMPOSER_LAYOUT.workspaceButtonClassName,
      /bg-transparent/,
    );
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
      /min-h-\[2\.25rem\]/,
    );
    assert.match(
      EMPTY_STATE_COMPOSER_LAYOUT.textareaContentClassName,
      /min-h-\[2\.25rem\]/,
    );
    assert.equal(COMPOSER_PLACEHOLDER, "Work with Rah");
    assert.match(
      EMPTY_STATE_COMPOSER_LAYOUT.textareaClassName,
      /focus:outline-none/,
    );
    assert.match(
      EMPTY_STATE_COMPOSER_LAYOUT.textareaClassName,
      /\bfont-normal\b/,
    );
    assert.match(
      EMPTY_STATE_COMPOSER_LAYOUT.textareaClassName,
      /focus:ring-0/,
    );
    assert.match(
      EMPTY_STATE_COMPOSER_LAYOUT.textareaContentClassName,
      /\bleading-6\b/,
    );
    assert.match(
      EMPTY_STATE_COMPOSER_LAYOUT.textareaContentClassName,
      /\bfont-normal\b/,
    );
    assert.match(COMPOSER_LAYOUT.textareaClassName, /\bfont-normal\b/);
    assert.match(COMPOSER_LAYOUT.textareaContentClassName, /\bfont-normal\b/);
    assert.match(EMPTY_STATE_COMPOSER_LAYOUT.controlsRowClassName, /\bmt-1\b/);
    assert.doesNotMatch(EMPTY_STATE_COMPOSER_LAYOUT.controlsRowClassName, /absolute|bottom-/);
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
    const modeSource = readSource("./components/SessionModeControls.tsx");
    const modelSource = readSource("./components/SessionModelControls.tsx");
    const surfaceSource = readSource("./components/UnifiedComposerSurface.tsx");
    const styles = readSource("./styles.css");

    assert.match(source, /<UnifiedComposerToolbar/);
    assert.match(source, /<SessionModeControls/);
    assert.match(source, /<SessionModelControls/);
    assert.match(source, /<ProviderSelector/);
    assert.match(source, /ResizeObserver/);
    assert.doesNotMatch(source, /<SessionControlPopover/);
    assert.doesNotMatch(source, /triggerTitle="New task settings"/);
    assert.doesNotMatch(source, /rah-new-session-settings-label/);
    assert.match(surfaceSource, /rah-composer-toolbar-leading/);
    assert.match(surfaceSource, /rah-composer-toolbar-trailing/);
    assert.match(modeSource, /variant\?: "compact" \| "toolbar" \| "composer"/);
    assert.match(modeSource, /data-composer-control="permissions"/);
    assert.match(modeSource, /data-composer-control="plan"/);
    assert.match(modeSource, /data-plan-active={props\.planModeEnabled \? "true" : "false"\}/);
    assert.match(modeSource, /border border-transparent bg-transparent/);
    assert.match(modelSource, /appearance\?: "default" \| "composer"/);
    assert.match(modelSource, /data-composer-control=\{composerAppearance \? "model"/);
    assert.match(modelSource, /border border-transparent bg-transparent/);
    assert.match(providerSource, /max-w-none[\s\S]*sm:max-w-\[24rem\]/);
    assert.doesNotMatch(providerSource, /selectedOptionIndex/);
    assert.doesNotMatch(providerSource, /translateX\(/);
    assert.match(providerSource, /grid h-9[\s\S]*gap-0 p-0/);
    assert.match(providerSource, /hidden whitespace-nowrap sm:inline-block/);
    assert.match(providerSource, /data-provider-selector="module"/);
    assert.match(providerSource, /provider-choice-option/);
    assert.match(providerSource, /provider-choice-option-with-label/);
    assert.match(providerSource, /provider-choice-label-text/);
    assert.match(styles, /\.provider-choice-module:hover/);
    assert.match(
      styles,
      /\.rah-composer-plan-toggle\[data-plan-active="true"\] \{\s*color: var\(--app-resource-link\);\s*\}/,
    );
    assert.doesNotMatch(
      styles,
      /\.rah-composer-plan-toggle\[data-plan-active="true"\][^{]*\{[^}]*(?:background|box-shadow):/,
    );
    assert.match(
      styles,
      /\.provider-choice-module \{[\s\S]*border: 0;[\s\S]*box-shadow: none;/,
    );
    assert.match(
      styles,
      /\.provider-choice-option\.is-selected \{[\s\S]*background: transparent;[\s\S]*box-shadow: none;[\s\S]*font-weight: 600;/,
    );
    assert.match(
      styles,
      /\.provider-choice-option::after \{[\s\S]*width: 1\.25rem;[\s\S]*height: 2px;/,
    );
    assert.match(
      styles,
      /\.provider-choice-label-text::after \{[\s\S]*right: 0;[\s\S]*left: 0;[\s\S]*height: 2px;[\s\S]*background: var\(--app-resource-link\);/,
    );
    assert.match(
      styles,
      /@media \(min-width: 43\.75rem\)[\s\S]*\.provider-choice-option-with-label::after[\s\S]*display: none;/,
    );
    assert.match(styles, /\.provider-choice-option:focus-visible[\s\S]*outline: none/);
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
    assert.match(selectedPaneSource, /<SessionModeControls/);
    assert.match(selectedPaneSource, /<SessionModelControls/);
    assert.match(selectedPaneSource, /data-resume-composer-controls="true"/);
    assert.doesNotMatch(selectedPaneSource, /<SessionControlPopover/);
    assert.match(selectedPaneSource, /variant="composer"/);
    assert.match(selectedPaneSource, /appearance="composer"/);
    assert.match(
      selectedPaneSource,
      /!props\.canSwitchSessionModes \|\|[\s\S]*sessionControlBusy \|\|[\s\S]*props\.modeChangePending/,
    );
    assert.match(
      selectedPaneSource,
      /!props\.canSwitchSessionModel \|\|[\s\S]*sessionControlBusy \|\|[\s\S]*props\.modelChangePending/,
    );
    assert.match(
      selectedPaneSource,
      /selectedModelId=\{[\s\S]*useResumeConfiguration[\s\S]*props\.selectedResumeModelId/,
    );
    assert.match(
      source,
      /props\.showModel && Boolean\(props\.modelCatalog \|\| props\.modelCatalogLoading \|\| props\.onOpen\)/,
    );
    assert.match(
      selectedPaneSource,
      /const useResumeConfiguration =[\s\S]*resumeOnSend \|\|[\s\S]*props\.resumeModePending/,
    );
    assert.match(
      selectedPaneSource,
      /\{props\.composerSurface\.kind === "compose" \? \([\s\S]*<SessionModelControls/,
    );
    assert.doesNotMatch(selectedPaneSource, /showLiveModelControl/);
    assert.doesNotMatch(selectedPaneSource, /showLiveAccessModeControl/);
    assert.match(
      readSource("./components/SessionModeControls.tsx"),
      /if \(!composer && props\.accessModes\.length === 0 && !props\.planModeAvailable\)/,
    );
    assert.doesNotMatch(
      selectedPaneSource,
      /resumeOnSend\s*\?\s*Boolean\(props\.modelCatalog \|\| props\.modelCatalogLoading\)/,
    );
    assert.doesNotMatch(selectedPaneSource, /lockedMessage=/);
  });

  test("moves workspace selection below the composer while keeping agent controls unified", () => {
    const appSource = readSource("./App.tsx");
    const source = readSource(
      "./components/workbench/panes/NewSessionComposer.tsx",
    );
    const styles = readSource("./styles.css");
    const composerStart = source.indexOf('<UnifiedComposerSurface');
    const composerEnd = source.indexOf('</UnifiedComposerSurface>', composerStart);
    const workspaceStrip = source.indexOf('rah-new-task-workspace-strip', composerEnd);
    const workspaceControl = source.indexOf("props.workspaceDirs.length === 0", workspaceStrip);
    const sessionControl = source.indexOf("<SessionModeControls", composerStart);
    const modelControl = source.indexOf("<SessionModelControls", composerStart);
    const sendControl = source.indexOf('aria-label="Start session"', composerStart);

    assert.doesNotMatch(source, /NewSessionWorkspaceContext/);
    assert.match(source, /What would you like to build\?/);
    assert.doesNotMatch(source, /workspaceStripTriggerClassName/);
    assert.doesNotMatch(source, /className="relative z-0 -mb-3"/);
    assert.ok(composerStart >= 0);
    assert.ok(sessionControl > composerStart && sessionControl < composerEnd);
    assert.ok(modelControl > sessionControl && modelControl < composerEnd);
    assert.ok(sendControl > modelControl && sendControl < composerEnd);
    assert.ok(workspaceStrip > composerEnd);
    assert.ok(workspaceControl > workspaceStrip);
    assert.match(source, /EMPTY_STATE_COMPOSER_LAYOUT\.workspaceButtonClassName/);
    assert.match(source, /rah-new-task-composer-stack/);
    assert.match(styles, /\.rah-new-task-workspace-strip[\s\S]*margin: -0\.5rem 0\.75rem 0/);
    assert.match(styles, /\.rah-new-task-workspace-strip[\s\S]*height: 2\.5rem/);
    assert.doesNotMatch(source, /iconOnlyWorkspace|controlsRowWidth/);
    assert.match(source, /rah-marquee min-w-0 flex-1 text-left/);
    assert.match(source, /const workspaceShouldMarquee = workspaceLabel\.length > 18/);
    assert.match(source, /<Folder size=\{14\}/);
    assert.match(source, /<ChevronDown[\s\S]*size=\{12\}/);
    assert.match(source, /<ProviderSelector/);
    assert.match(source, /<OverlayScrollArea/);
    assert.match(source, /Add workspace…/);
    assert.match(source, /<WorkspacePicker/);
    assert.doesNotMatch(source, /<SessionControlPopover/);
    assert.match(source, /<SessionModeControls/);
    assert.match(source, /<SessionModelControls/);
    assert.doesNotMatch(source, /mobileIconOnly=\{isPwaDisplayMode\}/);
    assert.doesNotMatch(source, /iconOnly=\{isPwaDisplayMode\}/);
    assert.match(
      styles,
      /data-surface="new-task"[\s\S]*\.rah-composer-toolbar[\s\S]*display: grid/,
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
    assert.match(appSource, /reason:\s*"session-visible"/);
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

  test("balances the shared secondary composer glyphs against the primary action", () => {
    const attachmentSource = readSource("./components/ComposerAttachmentControl.tsx");
    const modeSource = readSource("./components/SessionModeControls.tsx");
    const modelSource = readSource("./components/SessionModelControls.tsx");
    const newSessionSource = readSource(
      "./components/workbench/panes/NewSessionComposer.tsx",
    );

    assert.match(
      attachmentSource,
      /<Plus[\s\S]*?size=\{20\}[\s\S]*?strokeWidth=\{1\.75\}/,
    );
    assert.match(
      newSessionSource,
      /<Plus[\s\S]*?size=\{20\}[\s\S]*?strokeWidth=\{1\.75\}/,
    );
    assert.match(
      modeSource,
      /<Shield[\s\S]*?size=\{15\}[\s\S]*?strokeWidth=\{1\.8\}/,
    );
    assert.match(modelSource, /strokeWidth=\{composerAppearance \? 1\.8 : 2\}/);
    assert.match(modeSource, /border border-transparent bg-transparent/);
    assert.match(modelSource, /border border-transparent bg-transparent/);
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

  test("shares one white composer surface and wires selected response text into Chat", () => {
    const newSessionSource = readSource(
      "./components/workbench/panes/NewSessionComposer.tsx",
    );
    const selectedPaneSource = readSource(
      "./components/workbench/panes/WorkbenchSelectedPane.tsx",
    );
    const chatThreadSource = readSource("./components/chat/ChatThread.tsx");
    const assistantSource = readSource("./components/chat/AssistantMessage.tsx");
    const sessionStoreSource = readSource("./useSessionStore.ts");
    const styles = readSource("./styles.css");

    assert.match(newSessionSource, /<UnifiedComposerSurface/);
    assert.match(selectedPaneSource, /<UnifiedComposerSurface/);
    assert.match(newSessionSource, /surface="new-task"/);
    assert.match(selectedPaneSource, /surface="chat"/);
    assert.match(newSessionSource, /placeholder=\{COMPOSER_PLACEHOLDER\}/);
    assert.match(newSessionSource, /rows=\{1\}/);
    assert.match(selectedPaneSource, /placeholder=\{COMPOSER_PLACEHOLDER\}/);
    assert.match(selectedPaneSource, /data-composer-primary-action="stop"/);
    assert.match(selectedPaneSource, /data-composer-primary-action="send"/);
    assert.doesNotMatch(selectedPaneSource, /stopSpinner|app-danger/);
    assert.match(selectedPaneSource, /<ComposerAnnotationBadge/);
    assert.match(selectedPaneSource, /onAddSelectedText/);
    assert.match(selectedPaneSource, /onSelectedTextMoreDetails/);
    assert.match(chatThreadSource, /<SelectedTextOverlay/);
    assert.match(chatThreadSource, /onMouseUpCapture=\{handlePotentialTextSelectionEnd\}/);
    assert.match(assistantSource, /data-selection-source="conversation-message"/);
    assert.match(
      sessionStoreSource,
      /initialAnnotations: options\.initialAnnotations/,
    );
    assert.match(styles, /\.rah-unified-composer\s*\{/);
    assert.match(
      styles,
      /\.rah-unified-composer\[data-surface="chat"\]\[data-pwa="true"\]:is\([\s\S]*:focus-within,[\s\S]*:has\(\[data-composer-control\]\[aria-expanded="true"\]\)/,
    );
    assert.match(
      styles,
      /data-surface="chat"\]\[data-pwa="true"\]:not\(:focus-within\):not\(:has\(\[data-composer-control\]\[aria-expanded="true"\]\)\)[\s\S]*grid-template-rows: 2\.5rem/,
    );
    assert.match(styles, /\.rah-chat-composer-secondary/);
    assert.match(styles, /\.rah-composer-toolbar-leading/);
    assert.match(styles, /display: contents/);
    assert.match(styles, /white-space: nowrap/);
    assert.doesNotMatch(styles, /\.rah-unified-composer:focus-within/);
    assert.match(newSessionSource, /<UnifiedComposerToolbar/);
    assert.doesNotMatch(styles, /data-surface="new-task"[^\n]*:focus-within/);
    assert.match(selectedPaneSource, /rah-chat-composer-input/);
    assert.match(selectedPaneSource, /rah-chat-composer-context/);
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
