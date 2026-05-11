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
      "packages/client-web/src/session-store-history.test.ts",
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
      "packages/client-web/src/session-store-history.test.ts",
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
      "packages/runtime-daemon/src/zellij-tui-runtime.test.ts",
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
      "packages/runtime-daemon/src/zellij-tui-runtime.test.ts",
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
      "packages/runtime-daemon/src/zellij-tui-runtime.test.ts",
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
    id: "REAL-CLAUDE-ZELLIJ-MIRROR-001",
    severity: "P0",
    providers: ["claude"],
    automation: ["real_provider"],
    title: "Real Claude zellij Chat is a JSONL/history mirror, not authoritative busy state",
    acceptance: [
      "The smoke creates a real Claude zellij_tui session.",
      "Chat output is accepted only after the Claude history mirror contains the expected marker.",
      "The test does not wait on runtimeState=running/idle as Claude truth.",
    ],
    evidence: [
      "scripts/claude_browser_smoke.py",
      "docs/claude-zellij-native-mode.zh-CN.md",
    ],
  },
  {
    id: "REAL-CLAUDE-PASSTHROUGH-001",
    severity: "P0",
    providers: ["claude"],
    automation: ["real_provider"],
    title: "Real Claude zellij Web Chat input is forwarded to the native TUI",
    acceptance: [
      "A claimed Claude history session accepts a second Web Chat prompt.",
      "The second prompt marker appears once as user input and once in the assistant answer.",
      "RAH does not use a hidden Claude queue as the authoritative send gate.",
    ],
    evidence: [
      "scripts/claude_browser_smoke.py",
      "packages/runtime-daemon/src/zellij-tui-runtime.test.ts",
    ],
  },
  {
    id: "REAL-CLAUDE-ESC-BEST-EFFORT-001",
    severity: "P0",
    providers: ["claude"],
    automation: ["real_provider"],
    title: "Real Claude zellij exposes a yellow best-effort Esc control instead of red Stop",
    acceptance: [
      "The red Stop generating button is absent for Claude zellij sessions.",
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
    title: "Real Claude zellij Esc does not create synthetic interrupt chat notices",
    acceptance: [
      "Esc does not append Conversation interrupted to Chat.",
      "Repeated Esc actions do not create duplicate or drifting interrupt notices.",
      "A recovery prompt after Esc still reaches the same Claude session.",
    ],
    evidence: [
      "scripts/claude_browser_smoke.py",
      "packages/runtime-daemon/src/zellij-tui-runtime.test.ts",
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
    id: "REAL-CLAUDE-HISTORY-CLAIM-001",
    severity: "P0",
    providers: ["claude"],
    automation: ["real_provider"],
    title: "Real Claude history claim resumes into zellij live mode without duplicating old turns",
    acceptance: [
      "Read-only Claude replay can be claimed into a live zellij session.",
      "Claiming does not increase the visible count of the old first-turn marker.",
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
    title: "Real Claude zellij Web Chat can send follow-up turns after previous output appears",
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
      "packages/client-web/src/session-store-history.test.ts",
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
    id: "REAL-HISTORY-CLAIM-001",
    severity: "P0",
    providers: ["codex", "opencode"],
    automation: ["real_provider"],
    title: "Real provider history claim resumes into a live session without duplicating older turns",
    acceptance: [
      "Read-only replay can be claimed into a live session.",
      "Claiming does not increase the visible count of the old first-turn marker.",
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
      "packages/client-web/src/session-store-history.test.ts",
      "docs/history-browsing.zh-CN.md",
      "scripts/history_claim_smoke.py",
    ],
  },
  {
    id: "HISTORY-CLAIM-001",
    severity: "P0",
    providers: ["codex", "claude", "opencode"],
    automation: ["unit", "fake_browser"],
    title: "Claiming history transfers replay to live without reordering or title regression",
    acceptance: [
      "Read-only replay remains browse-only until claim.",
      "Claimed live session keeps existing replay transcript order.",
      "Provider title/name remains aligned with provider-native history metadata.",
    ],
    evidence: [
      "scripts/history_claim_smoke.py",
      "packages/runtime-daemon/src/history-snapshots.test.ts",
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
      "Retry attempts may be visible as compact grey diagnostics.",
      "The final user-facing error is concise and appears in the correct turn position.",
      "Raw headers and large JSON bodies are not rendered as chat content.",
    ],
    evidence: [
      "scripts/native_provider_browser_smoke.py",
      "docs/provider-regression-testing.zh-CN.md",
    ],
  },
  {
    id: "CLAUDE-ZELLIJ-001",
    severity: "P0",
    providers: ["claude"],
    automation: ["unit", "fake_browser", "real_provider"],
    title: "Claude zellij fallback keeps chat, TUI surface, and local terminal synchronized",
    acceptance: [
      "Opening Web chat does not detach the local terminal unless Web TUI surface is activated.",
      "Activating Web TUI claims the surface and shows the local terminal overlay.",
      "Releasing/archive cleans up the overlay and zellij session correctly.",
    ],
    evidence: [
      "packages/runtime-daemon/src/zellij-tui-runtime.test.ts",
      "packages/runtime-daemon/src/rah-cli-pty-first.test.ts",
      "scripts/zellij_real_tui_launch_probe.ts",
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
      "packages/runtime-daemon/src/zellij-tui-runtime.test.ts",
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
      "packages/runtime-daemon/src/zellij-tui-runtime.test.ts",
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
      "No late PTY or zellij subscription frame resurrects the session.",
      "The local terminal no longer receives raw mouse/keyboard escape garbage after detach.",
    ],
    evidence: [
      "packages/runtime-daemon/src/zellij-tui-runtime.test.ts",
      "scripts/zellij-real-tui-exit-smoke.sh",
    ],
  },
  {
    id: "ARCHIVE-001",
    severity: "P0",
    providers: ["codex", "claude", "opencode"],
    automation: ["unit", "fake_browser"],
    title: "Archive closes managed clients, zellij panes, and PTY state without deleting provider history",
    acceptance: [
      "Archive removes the session from live lists.",
      "Managed native server clients or zellij sessions are closed.",
      "Provider history remains available in Sessions/History.",
    ],
    evidence: [
      "packages/runtime-daemon/src/runtime-engine.test.ts",
      "packages/runtime-daemon/src/zellij-tui-runtime.test.ts",
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
    title: "Council room configuration and member TUI views remain usable on small screens",
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
