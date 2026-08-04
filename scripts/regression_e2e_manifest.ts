type Severity = "P0" | "P1" | "P2";
type Automation = "unit" | "fake_browser" | "fake_daemon" | "real_provider" | "manual";
type Provider = "codex" | "claude" | "opencode" | "all";

interface RegressionCase {
  id: string;
  severity: Severity;
  providers: Provider[];
  automation: Automation[];
  title: string;
  acceptance: string[];
  evidence: string[];
}

const cases: RegressionCase[] = [
  {
    id: "TRANSCRIPT-ORDER-001",
    severity: "P0",
    providers: ["all"],
    automation: ["unit", "fake_browser"],
    title: "Chat bubbles keep provider order across live, mirror, and history replay",
    acceptance: [
      "A two-turn flow renders as user1, assistant1, user2, assistant2.",
      "No assistant bubble may move above the user bubble that caused it.",
      "The order is unchanged after browser refresh and selecting the session from the sidebar.",
    ],
    evidence: [
      "packages/client-web/src/types.test.ts",
      "packages/client-web/src/conversation.test.ts",
      "scripts/native_provider_browser_smoke.py",
      "scripts/native_codex_browser_smoke.py",
    ],
  },
  {
    id: "TRANSCRIPT-UNIQUE-001",
    severity: "P0",
    providers: ["all"],
    automation: ["unit", "fake_browser"],
    title: "Live/history echo does not duplicate user, reasoning, assistant, or tool timeline items",
    acceptance: [
      "A live item and its persisted history copy merge by canonicalItemId.",
      "Identity-less items are not merged by text alone.",
      "Streaming updates replace the same visible item instead of appending bubbles.",
    ],
    evidence: [
      "packages/runtime-daemon/src/timeline-reconciler.test.ts",
      "packages/client-web/src/types.test.ts",
      "packages/client-web/src/session-store-sync.test.ts",
    ],
  },
  {
    id: "TRANSCRIPT-REPEAT-001",
    severity: "P0",
    providers: ["all"],
    automation: ["unit", "fake_browser"],
    title: "Intentional repeated user text remains visible as separate turns",
    acceptance: [
      "Sending '继续' twice renders two user bubbles.",
      "Same assistant text in two distinct turns renders twice.",
      "Pagination and refresh do not collapse the repeated turns.",
    ],
    evidence: [
      "packages/client-web/src/types.test.ts",
      "packages/client-web/src/conversation.test.ts",
    ],
  },
  {
    id: "INTERRUPT-ANCHOR-001",
    severity: "P0",
    providers: ["all"],
    automation: ["unit", "fake_browser"],
    title: "Stop notice appears once and stays anchored to the interrupted turn",
    acceptance: [
      "Clicking Stop creates at most one Conversation interrupted notice for that turn.",
      "A second Stop confirmation for the same turn replaces the notice instead of duplicating it.",
      "A later Stop on another turn cannot move an earlier notice.",
    ],
    evidence: [
      "packages/client-web/src/types.test.ts",
      "packages/runtime-daemon/src/timeline-reconciler.test.ts",
    ],
  },
  {
    id: "INTERRUPT-STATE-001",
    severity: "P0",
    providers: ["all"],
    automation: ["unit", "fake_browser", "real_provider"],
    title: "Stop is visible immediately after accepted Web input and disappears after terminal state settles",
    acceptance: [
      "Web send switches the session to running even when native TUI input is queued.",
      "Stop remains visible while queued or active work can still be interrupted.",
      "Stop disappears after completed, failed, canceled, or confirmed prompt clean idle state.",
    ],
    evidence: [
      "packages/runtime-daemon/src/runtime-engine.test.ts",
      "packages/runtime-daemon/src/tmux-tui-runtime.test.ts",
      "packages/client-web/src/composer-contract.test.ts",
    ],
  },
  {
    id: "INTERRUPT-MULTI-001",
    severity: "P0",
    providers: ["codex", "claude", "opencode"],
    automation: ["unit", "fake_browser", "real_provider"],
    title: "Repeated Stop clicks do not exit or corrupt the provider TUI",
    acceptance: [
      "Repeated Stop requests are idempotent while stopPending is active.",
      "Codex and Claude do not exit from repeated Ctrl-C/Esc forwarding.",
      "OpenCode receives the provider-specific stop sequence without closing the session.",
    ],
    evidence: [
      "packages/runtime-daemon/src/runtime-terminal-coordinator.ts",
      "packages/runtime-daemon/src/tmux-tui-runtime.test.ts",
      "scripts/native_provider_browser_smoke.py",
    ],
  },
  {
    id: "QUEUE-INPUT-001",
    severity: "P0",
    providers: ["opencode", "codex"],
    automation: ["unit", "fake_browser"],
    title: "Web input queued behind dirty native TUI prompt is visible, interruptible, and later delivered",
    acceptance: [
      "A dirty prompt queues Web chat input instead of appending it to the local draft.",
      "The UI shows running/queued state and keeps Stop available.",
      "When the prompt becomes clean, the queued input is sent once.",
    ],
    evidence: [
      "packages/runtime-daemon/src/runtime-engine.test.ts",
      "packages/runtime-daemon/src/tmux-tui-runtime.test.ts",
      "packages/client-web/src/workbench-notice-contract.test.ts",
    ],
  },
  {
    id: "NEW-SESSION-001",
    severity: "P0",
    providers: ["codex", "claude", "opencode"],
    automation: ["fake_browser", "real_provider"],
    title: "New live session starts empty and never shows older-history loading chrome",
    acceptance: [
      "Before the first user turn, the chat has no older-history loading banner.",
      "The first submitted prompt appears once.",
      "Provider session id is registered before or during first input without requiring history file discovery.",
    ],
    evidence: [
      "scripts/native_provider_browser_smoke.py",
      "scripts/native_codex_browser_smoke.py",
      "packages/client-web/src/workbench-notice-contract.test.ts",
    ],
  },
  {
    id: "CODEX-CATALOG-ROOT-001",
    severity: "P0",
    providers: ["codex"],
    automation: ["unit", "fake_browser"],
    title: "Every user-owned Codex Desktop root appears in the canonical catalog",
    acceptance: [
      "Roots with originator=Codex Desktop and originator=codex_work_desktop are both cataloged.",
      "Explicit internal subagent rollouts remain excluded.",
      "A registered workspace shows the same user-owned active roots as Codex Desktop after refresh and reload.",
    ],
    evidence: [
      "packages/runtime-daemon/src/codex-stored-sessions.test.ts",
      "scripts/workspace_lifecycle_browser_smoke.py",
    ],
  },
  {
    id: "WORKSPACE-LIFECYCLE-001",
    severity: "P0",
    providers: ["all"],
    automation: ["unit", "fake_browser"],
    title: "Workspace add, reload, remove, and re-add remain usable without stale rows",
    acceptance: [
      "An empty Workspaces list can add a directory through the real picker.",
      "Reload preserves the exact workspace order and does not duplicate or drop rows.",
      "Removing the final workspace hides it immediately, and another workspace can then be added.",
    ],
    evidence: [
      "scripts/workspace_lifecycle_browser_smoke.py",
      "packages/client-web/src/useSessionStore.test.ts",
      "packages/runtime-daemon/src/workbench-state.test.ts",
    ],
  },
  {
    id: "WORKSPACE-PROJECTION-001",
    severity: "P0",
    providers: ["all"],
    automation: ["unit", "fake_browser"],
    title: "Sidebar sessions are a deterministic projection of registered visible workspaces",
    acceptance: [
      "A stored session appears under the most-specific registered workspace that owns its cwd.",
      "Removing a workspace hides its owned sessions in the same render without requiring reload.",
      "Removing a parent workspace does not hide an independently registered child workspace or its sessions.",
    ],
    evidence: [
      "scripts/workspace_lifecycle_browser_smoke.py",
      "packages/client-web/src/workbench-selectors.test.ts",
      "packages/client-web/src/session-store-workspace.test.ts",
      "packages/runtime-daemon/src/workbench-state.test.ts",
    ],
  },
  {
    id: "WORKSPACE-EMPTY-RECOVERY-001",
    severity: "P0",
    providers: ["all"],
    automation: ["fake_browser"],
    title: "The empty workspace state always retains a working add-workspace path",
    acceptance: [
      "The workspace picker opens while no workspace rows exist.",
      "Selecting a directory creates exactly one visible workspace row.",
      "The recovered row remains present after reload.",
    ],
    evidence: [
      "scripts/workspace_lifecycle_browser_smoke.py",
      "packages/client-web/src/components/WorkspacePicker.tsx",
    ],
  },
  {
    id: "WORKSPACE-NEW-TASK-001",
    severity: "P0",
    providers: ["all"],
    automation: ["unit", "fake_browser"],
    title: "Workspace-row New task opens the composer with that exact workspace selected",
    acceptance: [
      "Clicking New task in workspace opens the New task surface.",
      "The workspace selector title equals the clicked workspace's canonical path.",
      "Selecting or removing unrelated rows cannot silently replace that choice.",
    ],
    evidence: [
      "scripts/workspace_lifecycle_browser_smoke.py",
      "packages/client-web/src/composer-contract.test.ts",
      "packages/client-web/src/App.tsx",
    ],
  },
  {
    id: "PWA-COMPOSER-WORKSPACE-PILL-001",
    severity: "P1",
    providers: ["all"],
    automation: ["unit", "fake_browser"],
    title: "The iOS PWA New task composer keeps a compact workspace accessory",
    acceptance: [
      "Standalone iOS/PWA mode renders the selected workspace in a 40px accessory whose top 8px sits beneath the composer, leaving a 32px visible attachment with a 28px trigger.",
      "Labels longer than eighteen characters use the shared marquee while short names remain static.",
      "The accessory does not compete with agent controls or create horizontal document overflow at a 390px viewport.",
      "The borderless provider strip exposes exactly one selected item through 600 weight and a blue 20x2 icon marker on touch; pointer hover reveals one grouped surface, removes it after leave, and never adds item-level plates.",
    ],
    evidence: [
      "scripts/workspace_lifecycle_browser_smoke.py",
      "packages/client-web/src/composer-contract.test.ts",
      "packages/client-web/src/components/workbench/panes/NewSessionComposer.tsx",
    ],
  },
  {
    id: "PWA-CONVERSATION-DENSITY-001",
    severity: "P1",
    providers: ["all"],
    automation: ["unit", "fake_browser"],
    title: "The iOS PWA conversation uses readable type without wasting turn height",
    acceptance: [
      "PWA Session/Council copy uses the same selected 12-20px conversation token as Desktop without changing navigation or menu type.",
      "User bubbles are bounded to 75% width and their hidden touch copy action does not reserve a blank row.",
      "Ordinary PWA turn gaps are 12px and process commentary renders as flat page copy instead of a padded gray card.",
    ],
    evidence: [
      "packages/client-web/src/typography-contract.test.ts",
      "scripts/workspace_lifecycle_browser_smoke.py",
      "packages/client-web/src/components/chat/ChatThread.tsx",
    ],
  },
  {
    id: "PWA-GLOBAL-NOTICE-001",
    severity: "P1",
    providers: ["all"],
    automation: ["unit", "fake_browser"],
    title: "Global recovery notices stay compact and clear of primary controls",
    acceptance: [
      "Standalone PWA notices are anchored below the top safe-area control row instead of centered over page content.",
      "The compatibility notice is at most 72px high at 390x844 and does not overlap the New task composer.",
      "PWA and Wide Desktop share a low-contrast orange recovery tint blended into the normal surface and border, render without a drop shadow, and leave enough PWA host inset for every corner.",
      "Session Chat, Council, Canvas, and other titled workbench pages share one 40px single-line header contract; the PWA notice starts below that divider instead of using a page-specific offset.",
      "PWA copy omits verbose generation identifiers while retaining accessible Retry and Dismiss actions.",
      "Wide Desktop uses a compact inline toast no wider than 24rem with 16px right/bottom margins, independent from composer or floating-control anchors.",
    ],
    evidence: [
      "scripts/workspace_lifecycle_browser_smoke.py",
      "packages/client-web/src/components/workbench/callouts/GlobalWorkbenchCallout.test.ts",
      "packages/client-web/src/components/workbench/callouts/GlobalWorkbenchCallout.tsx",
      "packages/client-web/src/runtime-compatibility.test.ts",
      "packages/client-web/src/runtime-compatibility.ts",
    ],
  },
  {
    id: "PWA-TURN-CHANGE-PREVIEW-001",
    severity: "P1",
    providers: ["all"],
    automation: ["unit", "fake_browser"],
    title: "PWA turn-change previews close directly back to Chat",
    acceptance: [
      "Opening a Changed file on compact or medium layouts uses a transient viewer instead of opening the full-screen Inspector underneath it.",
      "Closing the transient file viewer returns directly to Chat with both Inspector panel states closed.",
      "Turn-level Review opened from either the reply card or active Task summary shares the same modal path and does not mutate Inspector visibility.",
      "Wide Desktop retains its Inspector-backed file workflow.",
    ],
    evidence: [
      "packages/client-web/src/responsive-layout.test.ts",
      "packages/client-web/src/sidebar-layout-contract.test.ts",
      "packages/client-web/src/App.tsx",
      "packages/client-web/src/components/chat/ChatThread.tsx",
      "scripts/workspace_lifecycle_browser_smoke.py",
    ],
  },
  {
    id: "COMPOSER-UNIFIED-SURFACE-001",
    severity: "P1",
    providers: ["all"],
    automation: ["unit", "fake_browser"],
    title: "New task and Chat use one white inset composer surface",
    acceptance: [
      "New task and Chat both render the shared white surface with one border, a 24px radius, and a restrained shadow instead of a gray input well.",
      "An empty desktop composer uses the shared 36px textarea baseline, shows `Work with Rah`, and stays at or below 110px tall before content grows it.",
      "Text, attachments, annotation context, add/settings controls, provider controls, and Send remain inside that surface.",
      "New task and Chat share one ghost toolbar: the foreground-color 20px/1.75 add action stays at the far left, permission/Plan stay on the left, model stays immediately before the primary action, and inactive controls do not draw independent pill borders.",
      "The New task provider selector has no persistent segmented rail, outer border, sliding highlight, or item-level plates; Desktop selection uses 600 weight and a blue underline exactly matching the label width, touch uses a blue 20x2 icon marker, and pointer hover adds only one transient grouped background.",
      "Chat has exactly one right-edge primary action: an empty working composer shows a static black-and-white Stop, while any new text or attachment replaces it with the black-and-white Send in the same slot; no red spinner or adjacent disabled Send remains.",
      "Standalone PWA Chat is a single inset row while idle, expands on focus or while a permission/model menu is open, exposes permission/Plan/model controls with bounded multiline text, then folds after menus close and focus leaves.",
      "New task keeps one fixed width, border, and shadow across focus states, always exposes permission/Plan/full model/effort, wraps its controls to two rows at 390px, and tucks the workspace accessory beneath the composer.",
      "Active Plan uses blue text, a restrained blue tint, and a 2px inset marker so it remains unambiguous without becoming a heavy pill.",
      "Each Session remembers its exact model, effort, and backend option values by provider session identity across reload, stop, and resume instead of returning to the catalog's strongest default.",
      "The 390px layout has no control overlap or horizontal document overflow in either composer.",
    ],
    evidence: [
      "scripts/workspace_lifecycle_browser_smoke.py",
      "packages/client-web/src/composer-contract.test.ts",
      "packages/client-web/src/components/UnifiedComposerSurface.tsx",
      "packages/client-web/src/components/workbench/panes/NewSessionComposer.tsx",
      "packages/client-web/src/components/workbench/panes/WorkbenchSelectedPane.tsx",
      "packages/client-web/src/session-model-preferences.test.ts",
      "packages/client-web/src/styles.css",
    ],
  },
  {
    id: "RESPONSE-ANNOTATION-001",
    severity: "P1",
    providers: ["all"],
    automation: ["unit", "fake_browser", "manual"],
    title: "Selected assistant text becomes structured composer context",
    acceptance: [
      "A selection contained by one assistant response opens a viewport-clamped Add to task / More details toolbar at the selection's first line.",
      "Clickable local-file labels remain natively selectable and copyable; completing a drag selection cannot accidentally open Inspector.",
      "Add to task stores the selection outside the editable draft, shows a hoverable annotation pill, and does not enable a blank submission by itself.",
      "More details stores the same annotation and inserts one editable explanatory prompt into the current Chat composer without creating a hidden task.",
      "The daemon validates annotation identity and limits, serializes the same ordered context for Codex, Claude/TUI, and OpenCode, then removes the transport envelope from visible replay while restoring structured annotations.",
    ],
    evidence: [
      "packages/client-web/src/components/chat/selected-text-overlay.test.ts",
      "packages/client-web/src/components/chat/MarkdownRenderer.test.tsx",
      "packages/client-web/src/typography-contract.test.ts",
      "packages/client-web/src/composer-annotations.test.ts",
      "packages/client-web/src/composer-contract.test.ts",
      "packages/runtime-daemon/src/http-server.test.ts",
      "packages/runtime-daemon/src/session-input-attachments.test.ts",
      "packages/runtime-daemon/src/session-input-queue.test.ts",
    ],
  },
  {
    id: "DESKTOP-CONVERSATION-DENSITY-001",
    severity: "P1",
    providers: ["all"],
    automation: ["unit", "fake_browser", "manual"],
    title: "Desktop conversation density improves readability and removes non-content height",
    acceptance: [
      "Desktop user, process, and final-answer copy default to 14px on a 22px line grid with a 430 variable-font weight; code defaults to 12px.",
      "Appearance persists one bounded 12-20px Session/Council conversation preference, derives a proportional code size, applies it immediately, and does not resize navigation or menus.",
      "Ordinary desktop turn gaps are 14px and final-answer block spacing is at most 12px.",
      "The user Copy action remains keyboard reachable but is overlaid on hover/focus instead of reserving a permanent row.",
      "Process commentary renders as flat page copy without a padded gray card.",
    ],
    evidence: [
      "packages/client-web/src/typography-contract.test.ts",
      "packages/client-web/src/components/chat/ChatThread.tsx",
      "packages/client-web/src/styles.css",
      "packages/client-web/src/hooks/useAppearancePreferences.ts",
      "packages/client-web/src/appearance-preferences.test.ts",
    ],
  },
  {
    id: "CHAT-MARKDOWN-IMAGES-001",
    severity: "P1",
    providers: ["all"],
    automation: ["unit", "fake_browser", "manual"],
    title: "Assistant Markdown images use a compact wrapping thumbnail gallery",
    acceptance: [
      "Consecutive image-only Markdown blocks coalesce into one wrapping row with a 12px gap, including images separated by blank lines.",
      "Local image thumbnails are capped at 160px high and remote thumbnails at 200px in both current and replayed assistant responses.",
      "A thumbnail remains clickable through the existing local Inspector or remote browser-preview path, and failed local resources retain a bounded placeholder.",
      "Ordinary paragraphs and paragraphs mixing text with an image keep normal Markdown flow instead of being classified as a gallery.",
    ],
    evidence: [
      "packages/client-web/src/components/chat/MarkdownRenderer.test.tsx",
      "packages/client-web/src/components/chat/MarkdownRenderer.tsx",
      "packages/client-web/src/components/chat/LocalImageResource.tsx",
      "packages/client-web/src/typography-contract.test.ts",
      "packages/client-web/src/styles.css",
      "scripts/workspace_lifecycle_browser_smoke.py",
    ],
  },
  {
    id: "TASK-SUMMARY-DENSITY-001",
    severity: "P1",
    providers: ["all"],
    automation: ["unit", "manual"],
    title: "Active task summary stays compact and uses pointer-appropriate disclosure",
    acceptance: [
      "The 32px dock pill shows only the plan icon, completed/total progress, and active step; Task summary, Working, and chevron chrome are absent.",
      "The detail footer omits redundant plan activity, labels commands as Run N commands, and keeps Changed N files plus activity on one non-wrapping row; when present, clickable Changed files is always the first and leftmost item.",
      "Wide Desktop reveals details through hover or keyboard focus; a pointer click does not pin the overlay after the pointer leaves.",
      "Standalone PWA reveals details only by tap, toggles closed on the second tap, and dismisses on outside tap or Escape.",
    ],
    evidence: [
      "packages/client-web/src/components/chat/current-plan.test.ts",
      "packages/client-web/src/components/chat/TaskSummaryDock.tsx",
      "packages/client-web/src/components/chat/conversation-activity-display.tsx",
    ],
  },
  {
    id: "SIDEBAR-DENSITY-001",
    severity: "P1",
    providers: ["all"],
    automation: ["unit", "deterministic_browser", "manual"],
    title: "Desktop and PWA sidebars share one locked Codex-compact visual protocol",
    acceptance: [
      "A new desktop profile starts at 272px, preserves a user-resized width, and double-clicking the resize divider resets and persists 272px.",
      "Header, navigation, group, workspace, and session labels use their documented 16/15/13/14/14px hierarchy and matching weights.",
      "Workspace and session rows are 30px high with a 10px selected radius, 2px same-group gaps, 6px workspace-group gaps, and 12px major-section gaps.",
      "Desktop and compact PWA use a 40px header without an underline; New task starts 4px below it.",
      "Desktop and compact PWA consume the same codex-compact-v1 CSS variables; pointer media queries may change action visibility and positioning only, never row geometry or typography.",
      "Hover and selected surfaces keep 8px content-edge inset on both sides, and workspace/session labels have zero vertical-center delta.",
      "Primary navigation hover and selection reuse the exact Session hover surface without a white active card, shadow, or pointer-focus outline on Desktop and PWA.",
      "Workspace icons use a 16px glyph in a 20px slot; Codex session rows have no leading provider icon, while Claude/OpenCode use their 16px bare provider logo without changing row height or title centering; the right rail remains reserved for status/actions.",
      "Session info tooltips use one idle/pending/open state machine and one sidebar-level Portal layer: delegated cross-row hover replaces the active target, pointer focus never pins it, leave/click/scroll/blur/visibility/Escape cancels visible and pending state, and stale epochs or detached anchors cannot reopen it.",
    ],
    evidence: [
      "packages/client-web/src/sidebar-layout-contract.test.ts",
      "packages/client-web/src/sidebar-layout-contract.ts",
      "packages/client-web/src/styles.css",
      "packages/client-web/src/components/Sheet.tsx",
      "packages/client-web/src/components/workbench/shells/WorkbenchSidebarShell.tsx",
      "packages/client-web/src/hooks/useWorkbenchChromeState.ts",
      "packages/client-web/src/components/workbench/actions/WorkbenchSidebarNavigation.tsx",
      "packages/client-web/src/SessionSidebar.tsx",
      "packages/client-web/src/sidebar-session-tooltip-state.test.ts",
      "packages/client-web/src/sidebar-session-tooltip-state.ts",
      "packages/client-web/src/useSidebarSessionTooltipController.ts",
      "scripts/workspace_lifecycle_browser_smoke.py",
    ],
  },
  {
    id: "TURN-CHANGES-AUTHORITY-001",
    severity: "P0",
    providers: ["codex"],
    automation: ["unit", "fake_daemon"],
    title: "Changed files summary and clicked diff come from the same authoritative turn artifact",
    acceptance: [
      "Codex patch_apply_end activity never synthesizes a Changed files card or historical diff.",
      "Each cumulative turn/diff/updated snapshot atomically replaces the previous paths and counts, including an empty snapshot.",
      "Conversation pages discard unbacked file-change summaries and restore only the frozen artifact keyed by provider session and turn.",
      "Clicking a visible path reads that artifact's exact per-file diff without consulting current workspace Git state.",
    ],
    evidence: [
      "packages/runtime-daemon/src/turn-artifact-store.test.ts",
      "packages/runtime-daemon/src/runtime-engine.test.ts",
      "packages/runtime-daemon/src/codex-turn-directory.test.ts",
      "packages/runtime-daemon/src/http-server.test.ts",
    ],
  },
  {
    id: "REAL-PROVIDER-001",
    severity: "P0",
    providers: ["codex", "claude", "opencode"],
    automation: ["real_provider"],
    title: "Release browser gate uses real provider CLIs/servers instead of fake provider binaries",
    acceptance: [
      "The release browser gate runs Codex, Claude, and OpenCode provider-specific smoke commands.",
      "The smoke scripts do not create fake provider binaries or mock session ids.",
      "Each provider reports ok=true and the real provider name in the machine-readable result.",
    ],
    evidence: [
      "scripts/regression_e2e_browser_gate.ts",
      "scripts/provider_browser_smoke.py",
      "scripts/claude_browser_smoke.py",
    ],
  },
  {
    id: "REAL-CLAUDE-TMUX-MIRROR-001",
    severity: "P0",
    providers: ["claude"],
    automation: ["real_provider"],
    title: "Real Claude TUI mux Chat is a JSONL/history mirror, not authoritative busy state",
    acceptance: [
      "The smoke creates a real Claude tui_mux session.",
      "Chat output is accepted only after the Claude history mirror contains the expected marker.",
      "The test does not wait on runtimeState=running/idle as Claude truth.",
    ],
    evidence: [
      "scripts/claude_browser_smoke.py",
      "docs/claude-tmux-native-mode.zh-CN.md",
    ],
  },
  {
    id: "REAL-CLAUDE-PASSTHROUGH-001",
    severity: "P0",
    providers: ["claude"],
    automation: ["real_provider"],
    title: "Real Claude TUI mux Web Chat input is forwarded to the native TUI",
    acceptance: [
      "A claimed Claude history session accepts a second Web Chat prompt.",
      "The second prompt marker appears once as user input and once in the assistant answer.",
      "RAH does not use a hidden Claude queue as the authoritative send gate.",
    ],
    evidence: [
      "scripts/claude_browser_smoke.py",
      "packages/runtime-daemon/src/tmux-tui-runtime.test.ts",
    ],
  },
  {
    id: "REAL-CLAUDE-ESC-BEST-EFFORT-001",
    severity: "P0",
    providers: ["claude"],
    automation: ["real_provider"],
    title: "Real Claude TUI mux exposes a yellow best-effort Esc control instead of red Stop",
    acceptance: [
      "The red Stop generating button is absent for Claude TUI mux sessions.",
      "The yellow Send Esc to Claude TUI button is visible and enabled.",
      "Double-clicking Esc does not close the Claude session.",
    ],
    evidence: [
      "scripts/claude_browser_smoke.py",
      "packages/client-web/src/composer-contract.test.ts",
    ],
  },
  {
    id: "REAL-CLAUDE-NO-SYNTHETIC-INTERRUPT-001",
    severity: "P0",
    providers: ["claude"],
    automation: ["real_provider"],
    title: "Real Claude TUI mux Esc does not create synthetic interrupt chat notices",
    acceptance: [
      "Esc does not append Conversation interrupted to Chat.",
      "Repeated Esc actions do not create duplicate or drifting interrupt notices.",
      "A recovery prompt after Esc still reaches the same Claude session.",
    ],
    evidence: [
      "scripts/claude_browser_smoke.py",
      "packages/runtime-daemon/src/tmux-tui-runtime.test.ts",
    ],
  },
  {
    id: "REAL-CLAUDE-HISTORY-REPLAY-001",
    severity: "P0",
    providers: ["claude"],
    automation: ["real_provider"],
    title: "Real Claude history replay shows persisted history without new-session noise",
    acceptance: [
      "After closing a seeded real Claude live session, Recent/Stored both contain the provider session id.",
      "Opening the history row shows the first turn marker.",
      "The chat body does not show Loading older history, Unhandled provider event, or Action failed noise.",
    ],
    evidence: [
      "scripts/claude_browser_smoke.py",
    ],
  },
  {
    id: "REAL-CLAUDE-HISTORY-RESUME-001",
    severity: "P0",
    providers: ["claude"],
    automation: ["real_provider"],
    title: "Real Claude history resume resumes into TUI mux live mode without duplicating old turns",
    acceptance: [
      "Read-only Claude replay can be claimed into a live TUI mux session.",
      "Resuming does not increase the visible count of the old first-turn marker.",
      "The claimed live session accepts a new browser turn.",
    ],
    evidence: [
      "scripts/claude_browser_smoke.py",
    ],
  },
  {
    id: "REAL-CLAUDE-SECOND-TURN-001",
    severity: "P0",
    providers: ["claude"],
    automation: ["real_provider"],
    title: "Real Claude TUI mux Web Chat can send follow-up turns after previous output appears",
    acceptance: [
      "The second prompt has exactly one matching user timeline item.",
      "A recovery prompt after Esc reaches Claude and returns an answer.",
      "The transcript order remains prompt, answer, Esc prompt, recovery prompt, recovery answer.",
    ],
    evidence: [
      "scripts/claude_browser_smoke.py",
    ],
  },
  {
    id: "REAL-CHAT-ORDER-001",
    severity: "P0",
    providers: ["codex", "opencode"],
    automation: ["real_provider"],
    title: "Real provider browser transcript keeps user/assistant/interrupt order",
    acceptance: [
      "A claimed real provider session renders the second user prompt before its assistant answer.",
      "A stopped turn renders its interrupt notice after the interrupted user prompt.",
      "A recovery prompt after interrupt renders after the interrupt notice and before its answer.",
    ],
    evidence: [
      "scripts/provider_browser_smoke.py",
    ],
  },
  {
    id: "REAL-CHAT-UNIQUE-001",
    severity: "P0",
    providers: ["codex", "opencode"],
    automation: ["real_provider"],
    title: "Real provider browser transcript rejects duplicate user/assistant bubbles",
    acceptance: [
      "The second-turn marker appears exactly twice: once in the user prompt and once in the assistant answer.",
      "The interrupted-turn marker appears exactly once because the assistant answer must not complete.",
      "The recovery marker appears exactly twice after interrupt recovery.",
    ],
    evidence: [
      "scripts/provider_browser_smoke.py",
    ],
  },
  {
    id: "REAL-STOP-NORMAL-IDLE-001",
    severity: "P0",
    providers: ["codex", "opencode"],
    automation: ["real_provider"],
    title: "Real provider Stop button disappears after normal completion",
    acceptance: [
      "Stop appears while a real provider turn is running when applicable.",
      "Stop is absent after a normal completed turn reaches idle.",
      "The Send button is enabled after idle so a follow-up prompt can be sent.",
    ],
    evidence: [
      "scripts/provider_browser_smoke.py",
    ],
  },
  {
    id: "REAL-INTERRUPT-ONCE-001",
    severity: "P0",
    providers: ["codex", "opencode"],
    automation: ["real_provider"],
    title: "Real provider interrupt notice appears once per stopped turn",
    acceptance: [
      "A real long-running turn exposes the Stop button.",
      "Double-clicking Stop does not create duplicate interrupt notices.",
      "The stopped turn remains in the chat as a single user prompt plus one interrupt notice.",
    ],
    evidence: [
      "scripts/provider_browser_smoke.py",
    ],
  },
  {
    id: "REAL-INTERRUPT-RECOVERY-001",
    severity: "P0",
    providers: ["codex", "opencode"],
    automation: ["real_provider"],
    title: "Real provider accepts a new Web chat turn after interrupt",
    acceptance: [
      "The session stays live after Stop instead of closing the provider TUI/client.",
      "Stop is absent and Send is enabled after the interrupted turn settles.",
      "A recovery prompt sent from Web chat reaches the same provider session and returns an answer.",
    ],
    evidence: [
      "scripts/provider_browser_smoke.py",
    ],
  },
  {
    id: "REAL-INTERRUPT-MULTI-TURN-001",
    severity: "P0",
    providers: ["codex", "opencode"],
    automation: ["real_provider"],
    title: "Real provider repeated interrupts keep old notices anchored and do not corrupt later turns",
    acceptance: [
      "Two separate stopped turns render exactly two interrupt notices.",
      "The second interrupt cannot move or duplicate the first interrupt notice.",
      "A recovery prompt after each interrupt reaches the provider and renders in order.",
    ],
    evidence: [
      "scripts/provider_browser_smoke.py",
      "packages/client-web/src/types.test.ts",
      "packages/client-web/src/conversation.test.ts",
    ],
  },
  {
    id: "REAL-HISTORY-REPLAY-001",
    severity: "P0",
    providers: ["codex", "opencode"],
    automation: ["real_provider"],
    title: "Real provider history replay shows the first real turn without new-session noise",
    acceptance: [
      "After closing a seeded real live session, Recent/Stored both contain the provider session id.",
      "Opening the history row shows the first turn marker.",
      "The chat body does not show Loading older history, Unhandled provider event, or Action failed noise.",
    ],
    evidence: [
      "scripts/provider_browser_smoke.py",
    ],
  },
  {
    id: "REAL-HISTORY-RESUME-001",
    severity: "P0",
    providers: ["codex", "opencode"],
    automation: ["real_provider"],
    title: "Real provider history resume resumes into a live session without duplicating older turns",
    acceptance: [
      "Read-only replay can be claimed into a live session.",
      "Resuming does not increase the visible count of the old first-turn marker.",
      "The claimed live session accepts a new browser turn.",
    ],
    evidence: [
      "scripts/provider_browser_smoke.py",
    ],
  },
  {
    id: "REAL-SECOND-TURN-001",
    severity: "P0",
    providers: ["codex", "opencode"],
    automation: ["real_provider"],
    title: "Real provider Web chat can send a second turn after the previous turn completes",
    acceptance: [
      "After the second turn completes, Stop is absent and Send is enabled.",
      "The second prompt has exactly one matching user timeline item.",
      "The session can send and receive an additional recovery prompt after an interrupt.",
    ],
    evidence: [
      "scripts/provider_browser_smoke.py",
    ],
  },
  {
    id: "REFRESH-LIVE-001",
    severity: "P0",
    providers: ["all"],
    automation: ["fake_browser"],
    title: "Browser refresh rebuilds the selected live session without duplicates or stale stop state",
    acceptance: [
      "After refresh, visible bubbles match the pre-refresh transcript.",
      "No duplicate user, assistant, reasoning, tool, or interrupt notice appears.",
      "If provider is idle, Stop is not visible after refresh.",
    ],
    evidence: [
      "scripts/native_provider_browser_smoke.py",
      "scripts/native_codex_browser_smoke.py",
    ],
  },
  {
    id: "HISTORY-PAGING-001",
    severity: "P0",
    providers: ["all"],
    automation: ["unit", "fake_browser"],
    title: "Older history paging prepends without scroll jump or duplicate live tail",
    acceptance: [
      "The newest page opens fast and does not load the whole session.",
      "Scrolling upward loads older pages while preserving the user's visible anchor.",
      "Older page merge does not duplicate already-rendered live or latest history items.",
    ],
    evidence: [
      "packages/client-web/src/session-store-conversation-directory.test.ts",
      "docs/history-browsing.zh-CN.md",
      "scripts/history_resume_smoke.py",
    ],
  },
  {
    id: "HISTORY-RESUME-001",
    severity: "P0",
    providers: ["codex", "claude", "opencode"],
    automation: ["unit", "fake_browser"],
    title: "Resuming history transfers replay to live without reordering or title regression",
    acceptance: [
      "Read-only replay remains browse-only until claim.",
      "Claimed live session keeps existing replay transcript order.",
      "Provider title/name remains aligned with provider-native history metadata.",
    ],
    evidence: [
      "scripts/history_resume_smoke.py",
      "packages/runtime-daemon/src/history-snapshots.test.ts",
    ],
  },
  {
    id: "BACKGROUND-RESUME-NAVIGATION-001",
    severity: "P0",
    providers: ["codex", "claude", "opencode"],
    automation: ["unit"],
    title: "A history resume finishing in the background never steals the user's newer selection",
    acceptance: [
      "Submitting to stopped session A still resumes A and sends the queued input even if the user opens B before resume completes.",
      "Resume completion may remap selection only while the user still has A's replay or A's claimed runtime selected.",
      "Late model, mode, permission, or rollback updates for A cannot overwrite a newer selection of B.",
      "A's replay/runtime projection and unread state still converge correctly in the background.",
    ],
    evidence: [
      "packages/client-web/src/session-store-session-startup.test.ts",
      "packages/client-web/src/session-store-session-lifecycle.ts",
      "packages/client-web/src/session-store-session-startup.ts",
    ],
  },
  {
    id: "HISTORY-RESUME-SEND-001",
    severity: "P0",
    providers: ["codex", "claude", "opencode"],
    automation: ["unit"],
    title: "A stopped-session Send joins activation without losing the question",
    acceptance: [
      "If a no-input history activation is already in flight, a later Send immediately stages the user message in the resident replay.",
      "Both callers share one provider resume request and cannot create duplicate runtimes.",
      "After resume resolves, the staged input is delivered exactly once to the returned runtime id.",
      "A failed resume or send removes only the matching optimistic item and restores the editable draft/attachments.",
    ],
    evidence: [
      "packages/client-web/src/session-store-session-startup.test.ts",
      "packages/client-web/src/session-store-session-startup.ts",
      "packages/client-web/src/hooks/useWorkbenchComposerState.ts",
    ],
  },
  {
    id: "STOP-STAYS-IN-CHAT-001",
    severity: "P0",
    providers: ["codex", "claude", "opencode"],
    automation: ["unit"],
    title: "Stopping the selected session keeps its loaded Chat visible",
    acceptance: [
      "The close command and a racing session.closed event both convert the selected live projection into one stopped read-only replay.",
      "Feed, paged conversation, and turn directory stay resident while live leases, diagnostics, and write capabilities are removed.",
      "The selected session id remains on that Chat; a following catalog refresh cannot navigate to New task or discard the replay.",
      "The retained composer remains Resume-on-send with permission, Plan, model, and effective effort controls mounted.",
    ],
    evidence: [
      "packages/client-web/src/session-store-session-lifecycle.test.ts",
      "packages/client-web/src/session-store-sync.test.ts",
      "packages/client-web/src/session-store-projections.test.ts",
      "packages/client-web/src/session-store-session-lifecycle.ts",
      "packages/client-web/src/components/workbench/panes/WorkbenchSelectedPane.tsx",
    ],
  },
  {
    id: "CODEX-EVENT-001",
    severity: "P0",
    providers: ["codex"],
    automation: ["unit", "fake_browser"],
    title: "Unknown or non-chat Codex app-server events do not create scary chat Event bubbles",
    acceptance: [
      "Events such as thread/goal/cleared and remoteControl/status/changed are classified as diagnostics or ignored.",
      "They do not appear as red Event bubbles in the chat transcript.",
      "Legitimate lifecycle effects still update runtime state when applicable.",
    ],
    evidence: [
      "packages/runtime-daemon/src/codex-app-server-activity.test.ts",
      "packages/runtime-daemon/src/provider-activity.test.ts",
    ],
  },
  {
    id: "CODEX-GOAL-001",
    severity: "P1",
    providers: ["codex"],
    automation: ["real_provider", "manual"],
    title: "Codex slash commands and goal mode remain usable through native TUI while chat mirror stays structured",
    acceptance: [
      "A /goal command entered in TUI does not corrupt Web chat order.",
      "Goal lifecycle messages either mirror as stable timeline events or stay in diagnostics.",
      "Web chat can continue the same session after TUI slash-command interaction.",
    ],
    evidence: [
      "docs/provider-regression-testing.zh-CN.md",
      "test-results/native-manual-qa.json",
    ],
  },
  {
    id: "CLAUDE-ABORT-CONTEXT-001",
    severity: "P0",
    providers: ["claude"],
    automation: ["unit", "fake_browser"],
    title: "Claude turn_aborted context is stripped from visible user and assistant messages",
    acceptance: [
      "A persisted <turn_aborted>...</turn_aborted> fragment is not shown inside user text.",
      "A pure turn_aborted context fragment is ignored as transcript noise.",
      "A corresponding interrupt notice is still shown once when the lifecycle is available.",
    ],
    evidence: [
      "packages/runtime-daemon/src/claude-session-files.test.ts",
    ],
  },
  {
    id: "CLAUDE-ERROR-001",
    severity: "P1",
    providers: ["claude"],
    automation: ["fake_browser", "real_provider"],
    title: "Claude API 429/503 retries do not dump large JSON above the user prompt",
    acceptance: [
      "Persisted Claude api_error records are filtered out of visible Chat history.",
      "If a runtime diagnostic is surfaced elsewhere, it stays concise and outside the transcript.",
      "Raw headers and large JSON bodies are not rendered as chat content.",
    ],
    evidence: [
      "scripts/native_provider_browser_smoke.py",
      "docs/provider-regression-testing.zh-CN.md",
    ],
  },
  {
    id: "CLAUDE-TMUX-001",
    severity: "P0",
    providers: ["claude"],
    automation: ["unit", "fake_browser", "real_provider"],
    title: "Claude TUI mux fallback keeps chat, TUI surface, and local terminal synchronized",
    acceptance: [
      "Opening Web chat does not detach the local terminal unless Web TUI surface is activated.",
      "Activating Web TUI claims the surface and shows the local terminal overlay.",
      "Releasing/archive cleans up the overlay and tmux session correctly.",
    ],
    evidence: [
      "packages/runtime-daemon/src/tmux-tui-runtime.test.ts",
      "packages/runtime-daemon/src/rah-cli-pty-first.test.ts",
      "scripts/native_real_tui_launch_probe.ts",
    ],
  },
  {
    id: "OPENCODE-STOP-001",
    severity: "P0",
    providers: ["opencode"],
    automation: ["unit", "fake_browser", "real_provider"],
    title: "OpenCode Stop interrupts the turn without exiting the TUI or losing chat mirror",
    acceptance: [
      "Stop produces an interrupt/abort info event when provider history exposes it.",
      "The TUI remains attached and usable after Stop.",
      "Web chat can send a follow-up turn after Stop.",
    ],
    evidence: [
      "packages/runtime-daemon/src/opencode-activity.test.ts",
      "packages/runtime-daemon/src/tmux-tui-runtime.test.ts",
      "scripts/opencode-browser-smoke.sh",
    ],
  },
  {
    id: "OPENCODE-MIRROR-001",
    severity: "P0",
    providers: ["opencode"],
    automation: ["unit", "fake_browser"],
    title: "OpenCode native server and database mirror both produce the same structured chat timeline",
    acceptance: [
      "Web chat receives messages from native server driven turns.",
      "Database mirror backfill does not duplicate the native server live item.",
      "Reasoning, tool, and assistant parts stay in one assistant turn.",
    ],
    evidence: [
      "packages/runtime-daemon/src/opencode-activity.test.ts",
      "packages/runtime-daemon/src/opencode-stored-sessions.test.ts",
      "scripts/native_provider_browser_smoke.py",
    ],
  },
  {
    id: "TUI-SURFACE-001",
    severity: "P0",
    providers: ["codex", "claude", "opencode"],
    automation: ["unit", "fake_browser"],
    title: "Only one active TUI surface controls rendering/input at a time",
    acceptance: [
      "Web TUI activation claims the active display surface.",
      "A stale terminal or Web TUI client cannot inject raw TUI input.",
      "Closing Web TUI deactivates only that TUI client, not the live chat session.",
    ],
    evidence: [
      "packages/runtime-daemon/src/tmux-tui-runtime.test.ts",
      "packages/runtime-daemon/src/http-server-websocket.ts",
      "packages/client-web/src/terminal-socket-close.test.ts",
    ],
  },
  {
    id: "TUI-EXIT-001",
    severity: "P0",
    providers: ["codex", "claude", "opencode"],
    automation: ["unit", "fake_browser", "fake_daemon", "real_provider"],
    title: "Provider /exit or process exit marks the RAH live session stopped and restores terminal input mode",
    acceptance: [
      "RAH stops listing the session as active live after provider exits.",
      "No late PTY or TUI mux subscription frame resurrects the session.",
      "The local terminal no longer receives raw mouse/keyboard escape garbage after detach.",
    ],
    evidence: [
      "packages/runtime-daemon/src/tmux-tui-runtime.test.ts",
      "scripts/native-tui-gate.sh",
    ],
  },
  {
    id: "ARCHIVE-001",
    severity: "P0",
    providers: ["codex", "claude", "opencode"],
    automation: ["unit", "fake_browser"],
    title: "Archive closes managed clients, tmux panes, and PTY state without deleting provider history",
    acceptance: [
      "Archive removes the session from live lists.",
      "Managed native server clients or tmux sessions are closed.",
      "Provider history remains available in Sessions/History.",
      "The workspace sidebar arms archive in red on the first click, archives only on a second click, and resets after the timeout without opening a dialog.",
    ],
    evidence: [
      "packages/runtime-daemon/src/runtime-engine.test.ts",
      "packages/runtime-daemon/src/tmux-tui-runtime.test.ts",
      "packages/client-web/src/sidebar-layout-contract.test.ts",
    ],
  },
  {
    id: "MISSING-CWD-001",
    severity: "P1",
    providers: ["all"],
    automation: ["unit", "fake_browser"],
    title: "Missing original workspace blocks claim/resume, not read-only history browsing",
    acceptance: [
      "Browsing history for a missing cwd does not prompt to create the directory.",
      "Claim/resume/new session validates cwd before launching provider.",
      "RAH does not silently fallback to an unrelated cwd.",
    ],
    evidence: [
      "packages/client-web/src/session-store-session-startup.test.ts",
      "packages/runtime-daemon/src/runtime-engine.test.ts",
      "scripts/native_codex_browser_smoke.py",
    ],
  },
  {
    id: "MOBILE-COMPOSER-001",
    severity: "P1",
    providers: ["all"],
    automation: ["unit", "fake_browser", "manual"],
    title: "Mobile composer, Stop, Hide/Archive, and TUI controls fit iPhone and iPad widths",
    acceptance: [
      "iPhone viewport uses compact icon-only controls where required.",
      "iPad portrait keeps canvas/session controls reachable.",
      "Stop and Send do not overlap the textarea or each other.",
    ],
    evidence: [
      "packages/client-web/src/sidebar-layout-contract.test.ts",
      "packages/client-web/src/terminal-viewport.test.ts",
      "scripts/native_codex_browser_smoke.py",
      "docs/ui-regression-checklist.zh-CN.md",
    ],
  },
  {
    id: "MOBILE-TUI-001",
    severity: "P1",
    providers: ["all"],
    automation: ["unit", "fake_browser", "manual"],
    title: "Mobile Web TUI input bridge does not steal scroll or randomly summon the keyboard",
    acceptance: [
      "Only the explicit input bridge/composer focuses mobile keyboard.",
      "Terminal scrollback can be scrolled without focusing input.",
      "Keyboard viewport shrink keeps terminal usable without large visual drift.",
    ],
    evidence: [
      "packages/client-web/src/terminal-mobile-bridge.test.ts",
      "packages/client-web/src/terminal-viewport.test.ts",
      "scripts/native_codex_browser_smoke.py",
    ],
  },
  {
    id: "COUNCIL-UI-001",
    severity: "P2",
    providers: ["codex", "claude", "opencode"],
    automation: ["unit", "manual"],
    title: "Council configuration and member TUI views remain usable on small screens",
    acceptance: [
      "Council setup uses the same provider/model/mode selection contracts as new session.",
      "Model option controls update when the selected model has no parameters.",
      "Member terminal panes do not render raw mux garbage in the chat layout.",
    ],
    evidence: [
      "packages/client-web/src/council/council-ui-state.test.ts",
      "packages/runtime-daemon/src/council/council-runtime.test.ts",
    ],
  },
];

function validateCases(items: readonly RegressionCase[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) {
      errors.push(`duplicate id: ${item.id}`);
    }
    ids.add(item.id);
    if (!/^[A-Z]+(?:-[A-Z]+)*-\d{3}$/.test(item.id)) {
      errors.push(`invalid id format: ${item.id}`);
    }
    if (item.acceptance.length === 0) {
      errors.push(`${item.id} has no acceptance criteria`);
    }
    if (item.evidence.length === 0) {
      errors.push(`${item.id} has no evidence links`);
    }
    if (item.severity === "P0" && !item.automation.some((kind) => kind !== "manual")) {
      errors.push(`${item.id} is P0 but has no automated coverage target`);
    }
  }
  return errors;
}

function renderMarkdown(items: readonly RegressionCase[]): string {
  const lines: string[] = [
    "# RAH Regression E2E Manifest",
    "",
    "| ID | Severity | Providers | Automation | Title |",
    "|---|---|---|---|---|",
  ];
  for (const item of items) {
    lines.push(
      `| ${item.id} | ${item.severity} | ${item.providers.join(", ")} | ${item.automation.join(", ")} | ${item.title} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderSummary(items: readonly RegressionCase[]): string {
  const bySeverity = new Map<Severity, number>();
  const byAutomation = new Map<Automation, number>();
  for (const item of items) {
    bySeverity.set(item.severity, (bySeverity.get(item.severity) ?? 0) + 1);
    for (const kind of item.automation) {
      byAutomation.set(kind, (byAutomation.get(kind) ?? 0) + 1);
    }
  }
  const formatMap = <T extends string>(map: Map<T, number>) =>
    [...map.entries()].map(([key, value]) => `${key}=${value}`).join(", ");
  return [
    `Regression cases: ${items.length}`,
    `Severity: ${formatMap(bySeverity)}`,
    `Automation: ${formatMap(byAutomation)}`,
  ].join("\n");
}

const args = new Set(process.argv.slice(2));
const errors = validateCases(cases);
if (args.has("--check")) {
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  console.log(renderSummary(cases));
  process.exit(0);
}

if (args.has("--json")) {
  console.log(JSON.stringify({ cases }, null, 2));
  process.exit(errors.length > 0 ? 1 : 0);
}

if (args.has("--markdown")) {
  console.log(renderMarkdown(cases));
  process.exit(errors.length > 0 ? 1 : 0);
}

console.log(renderSummary(cases));
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
