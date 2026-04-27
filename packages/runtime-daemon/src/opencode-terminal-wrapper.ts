import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import tty from "node:tty";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import {
  abortOpenCodeSession,
  createOpenCodeSession,
  getOpenCodeSession,
  promptOpenCodeSessionAsync,
  respondOpenCodePermission,
  resolveOpenCodeBinary,
  startOpenCodeServer,
  stopOpenCodeServer,
  subscribeOpenCodeEvents,
  type OpenCodeEvent,
  type OpenCodeServerHandle,
} from "./opencode-api";
import {
  createOpenCodeActivityState,
  startOpenCodeTurn,
  translateOpenCodeEvent,
  type OpenCodeActivityState,
} from "./opencode-activity";
import { NativeTerminalProcess } from "./native-terminal-process";
import {
  clearTerminalScreen,
  disableTerminalApplicationModes,
  enterAlternateScreen,
  leaveAlternateScreen,
  renderTerminalWrapperPanel,
  renderTerminalWrapperPanelForTerminal,
  restoreInheritedTerminalModes,
} from "./terminal-wrapper-panel";
import type { ProviderActivity } from "./provider-activity";
import { deriveTerminalWrapperRemoteControlState } from "./terminal-wrapper-remote-control";
import type {
  QueuedTurn,
  TerminalWrapperFromDaemonMessage,
  TerminalWrapperPromptState,
  TerminalWrapperToDaemonMessage,
} from "./terminal-wrapper-control";

type WrapperMode = "local_native" | "remote_writer";
type RemoteKeyboardInput = NodeJS.ReadStream & {
  setRawMode?: (mode: boolean) => void;
};

const REMOTE_PANEL_SETTLE_MS = 2_500;
const REMOTE_PANEL_SETTLE_REDRAW_MS = 250;
const REMOTE_CANCEL_FALLBACK_MS = 2_500;
const REMOTE_KEYBOARD_RAW_REFRESH_MS = 250;
const REMOTE_STTY_RAW_REFRESH_MS = 1_000;
const RECENT_REMOTE_TURN_GRACE_MS = 30_000;
const execFileAsync = promisify(execFile);

interface ParsedArgs {
  daemonUrl: string;
  cwd: string;
  resumeProviderSessionId?: string;
}

const DEFAULT_DAEMON_URL = "http://127.0.0.1:43111";

function parseArgs(argv: string[]): ParsedArgs {
  let daemonUrl = DEFAULT_DAEMON_URL;
  let cwd = process.cwd();
  let resumeProviderSessionId: string | undefined;
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === "--daemon-url") {
      daemonUrl = rest.shift() ?? daemonUrl;
      continue;
    }
    if (arg === "--cwd") {
      cwd = rest.shift() ?? cwd;
      continue;
    }
    if (arg === "--resume-provider-session-id") {
      resumeProviderSessionId = rest.shift();
      continue;
    }
    throw new Error(`Unknown argument: ${arg ?? ""}`);
  }
  return {
    daemonUrl,
    cwd,
    ...(resumeProviderSessionId ? { resumeProviderSessionId } : {}),
  };
}

function wrapperControlUrl(daemonUrl: string): string {
  const url = new URL(daemonUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/wrapper-control";
  url.search = "";
  return url.toString();
}

function send(socket: WebSocket, message: TerminalWrapperToDaemonMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const socket = new WebSocket(wrapperControlUrl(args.daemonUrl));

  let wrapperSessionId: string | null = null;
  let providerSessionId: string | null = null;
  let server: OpenCodeServerHandle | null = null;
  let activityState: OpenCodeActivityState | null = null;
  let stopEvents: (() => void) | null = null;
  let localTerminal: NativeTerminalProcess | null = null;
  let mode: WrapperMode = "local_native";
  let promptState: TerminalWrapperPromptState = "agent_busy";
  let pendingRemoteTurn: QueuedTurn | null = null;
  let remotePromptText: string | null = null;
  let remoteKeyboardHandler: ((chunk: Buffer | string) => void) | null = null;
  let remoteKeyboardInput: RemoteKeyboardInput | null = null;
  let remoteKeyboardRawModeTimer: NodeJS.Timeout | null = null;
  let remoteSttyRestoreState: string | null = null;
  let remoteSttyRawModeInFlight = false;
  let remoteSttyRawModeEnabled = false;
  let lastRemoteSttyRawModeMs = 0;
  let remoteReclaimRequested = false;
  let remotePanelActive = false;
  let lastRenderedRemotePanel: string | null = null;
  let remotePanelForceUntilMs = 0;
  let lastRemotePanelForceMs = 0;
  let remotePanelSettleTimer: NodeJS.Timeout | null = null;
  let remoteTurnRequestInFlight = false;
  let remoteTurnCancelRequested = false;
  let remoteTurnFinalized = false;
  let remoteTurnId: string | null = null;
  let recentRemoteTurnId: string | null = null;
  let recentRemoteTurnUntilMs = 0;
  let remoteCancelFallbackTimer: NodeJS.Timeout | null = null;
  let suppressCanceledRemoteEvents = false;
  let suppressCanceledRemoteEventsUntilMs = 0;
  const canceledRemoteTurnIds = new Set<string>();
  let exiting = false;

  function setPromptState(state: TerminalWrapperPromptState): void {
    if (!wrapperSessionId || promptState === state) {
      return;
    }
    promptState = state;
    send(socket, {
      type: "wrapper.prompt_state.changed",
      sessionId: wrapperSessionId,
      state,
    });
  }

  function currentRemoteState() {
    return deriveTerminalWrapperRemoteControlState({
      providerLabel: "OpenCode",
      hasPendingTurn: pendingRemoteTurn !== null,
      hasActiveTurn: remoteTurnRequestInFlight || remoteTurnId !== null || promptState === "agent_busy",
      promptState,
      cancelRequested: remoteTurnCancelRequested,
      reclaimRequested: remoteReclaimRequested,
    });
  }

  function clearRemotePanelSettleTimer(): void {
    if (remotePanelSettleTimer) {
      clearInterval(remotePanelSettleTimer);
      remotePanelSettleTimer = null;
    }
  }

  function scheduleRemotePanelSettleRedraw(): void {
    clearRemotePanelSettleTimer();
    remotePanelForceUntilMs = Date.now() + REMOTE_PANEL_SETTLE_MS;
    lastRemotePanelForceMs = 0;
    remotePanelSettleTimer = setInterval(() => {
      if (mode !== "remote_writer" || exiting || Date.now() > remotePanelForceUntilMs) {
        clearRemotePanelSettleTimer();
        return;
      }
      if (Date.now() - lastRemotePanelForceMs >= REMOTE_PANEL_SETTLE_REDRAW_MS) {
        renderRemotePanel({ force: true });
      }
    }, REMOTE_PANEL_SETTLE_REDRAW_MS);
  }

  function enterRemotePanel(force = false): void {
    if (remotePanelActive && !force) {
      return;
    }
    disableTerminalApplicationModes();
    enterAlternateScreen();
    disableTerminalApplicationModes();
    remotePanelActive = true;
  }

  function leaveRemotePanel(): void {
    if (!remotePanelActive) {
      return;
    }
    leaveAlternateScreen();
    remotePanelActive = false;
    lastRenderedRemotePanel = null;
    remotePanelForceUntilMs = 0;
    lastRemotePanelForceMs = 0;
    clearRemotePanelSettleTimer();
  }

  function renderRemotePanel(options: { force?: boolean } = {}): void {
    if (mode !== "remote_writer" || exiting || !wrapperSessionId) {
      lastRenderedRemotePanel = null;
      return;
    }
    refreshRemoteKeyboardRawMode();
    const control = currentRemoteState();
    const prompt = remotePromptText ?? pendingRemoteTurn?.text ?? "No active web prompt.";
    const panelArgs = {
      title: "RAH OpenCode Remote Control",
      status: control.status,
      statusTone: control.tone,
      sessionId: providerSessionId ?? wrapperSessionId,
      prompt,
      footer: control.footer,
      footerTone: control.tone,
    };
    const panel = renderTerminalWrapperPanel(panelArgs);
    if (!options.force && panel === lastRenderedRemotePanel) {
      return;
    }
    lastRenderedRemotePanel = panel;
    enterRemotePanel(options.force);
    clearTerminalScreen();
    process.stdout.write(`${renderTerminalWrapperPanelForTerminal(panelArgs)}\r\n`);
    lastRemotePanelForceMs = Date.now();
  }

  function applyRemotePanelNotice(): void {
    if (mode === "remote_writer") {
      renderRemotePanel();
    }
  }

  function getActivityTurnId(activity: ProviderActivity): string | undefined {
    return "turnId" in activity && typeof activity.turnId === "string" ? activity.turnId : undefined;
  }

  function isFinalTurnActivity(activity: ProviderActivity): boolean {
    return (
      activity.type === "turn_completed" ||
      activity.type === "turn_failed" ||
      activity.type === "turn_canceled"
    );
  }

  function isActiveRemoteTurnActivity(activity: ProviderActivity): boolean {
    const turnId = getActivityTurnId(activity);
    return turnId !== undefined && remoteTurnId !== null && turnId === remoteTurnId;
  }

  function clearRemoteCancelFallbackTimer(): void {
    if (remoteCancelFallbackTimer) {
      clearTimeout(remoteCancelFallbackTimer);
      remoteCancelFallbackTimer = null;
    }
  }

  function readSessionStatusType(event: OpenCodeEvent): string | undefined {
    if (event.type !== "session.status" || event.properties?.sessionID !== providerSessionId) {
      return undefined;
    }
    const status = event.properties.status;
    if (status === null || typeof status !== "object" || Array.isArray(status)) {
      return undefined;
    }
    const type = (status as Record<string, unknown>).type;
    return typeof type === "string" ? type : undefined;
  }

  function isSessionIdleEvent(event: OpenCodeEvent): boolean {
    return readSessionStatusType(event) === "idle";
  }

  function shouldIgnoreRemoteWriterIdleBusyEvent(event: OpenCodeEvent): boolean {
    return (
      mode === "remote_writer" &&
      !remoteTurnRequestInFlight &&
      remoteTurnId === null &&
      readSessionStatusType(event) === "busy"
    );
  }

  function shouldIgnoreRemoteWriterFinalizedEvent(event: OpenCodeEvent): boolean {
    return (
      mode === "remote_writer" &&
      remoteTurnFinalized &&
      remoteTurnId === null &&
      event.type === "session.status" &&
      !isSessionIdleEvent(event)
    );
  }

  function shouldAttachRecentRemoteTurn(event: OpenCodeEvent): boolean {
    return (
      mode === "remote_writer" &&
      remoteTurnFinalized &&
      remoteTurnId === null &&
      recentRemoteTurnId !== null &&
      Date.now() <= recentRemoteTurnUntilMs &&
      event.properties?.sessionID === providerSessionId &&
      (event.type === "message.updated" ||
        event.type === "message.part.updated" ||
        event.type === "message.part.delta" ||
        event.type === "message.part.removed" ||
        event.type === "permission.asked" ||
        event.type === "permission.replied")
    );
  }

  function attachRecentRemoteTurnToActivityState(event: OpenCodeEvent): void {
    if (!activityState || !shouldAttachRecentRemoteTurn(event)) {
      return;
    }
    activityState.currentTurnId = recentRemoteTurnId!;
  }

  function shouldSuppressCanceledRemoteEvent(event: OpenCodeEvent): boolean {
    if (!suppressCanceledRemoteEvents) {
      return false;
    }
    if (Date.now() > suppressCanceledRemoteEventsUntilMs || isSessionIdleEvent(event)) {
      suppressCanceledRemoteEvents = false;
      suppressCanceledRemoteEventsUntilMs = 0;
      return false;
    }
    return event.properties?.sessionID === providerSessionId;
  }

  function publishActivity(activity: ProviderActivity): void {
    if (!wrapperSessionId) {
      return;
    }
    const originalTurnId = getActivityTurnId(activity);
    if (
      originalTurnId !== undefined &&
      canceledRemoteTurnIds.has(originalTurnId) &&
      activity.type !== "turn_canceled"
    ) {
      return;
    }
    if (
      mode === "remote_writer" &&
      remoteTurnCancelRequested &&
      isActiveRemoteTurnActivity(activity)
    ) {
      if (!isFinalTurnActivity(activity)) {
        return;
      }
      activity = {
        type: "turn_canceled",
        turnId: originalTurnId!,
        reason: "Stop requested",
      };
    }
    if (mode === "remote_writer" && remoteTurnFinalized && isFinalTurnActivity(activity)) {
      return;
    }
    send(socket, {
      type: "wrapper.activity",
      sessionId: wrapperSessionId,
      activity,
    });
    if (activity.type === "turn_started") {
      setPromptState("agent_busy");
    }
    if (
      activity.type === "turn_completed" ||
      activity.type === "turn_failed" ||
      activity.type === "turn_canceled"
    ) {
      const finalTurnId = getActivityTurnId(activity);
      if (activity.type === "turn_canceled" && finalTurnId) {
        canceledRemoteTurnIds.add(finalTurnId);
        suppressCanceledRemoteEvents = true;
        suppressCanceledRemoteEventsUntilMs = Date.now() + 5_000;
      }
      if (activityState?.currentTurnId && activityState.currentTurnId === finalTurnId) {
        delete activityState.currentTurnId;
      }
      if (mode === "remote_writer" && finalTurnId) {
        recentRemoteTurnId = finalTurnId;
        recentRemoteTurnUntilMs = Date.now() + RECENT_REMOTE_TURN_GRACE_MS;
      }
      remoteTurnRequestInFlight = false;
      remoteTurnCancelRequested = false;
      remoteTurnFinalized = true;
      remoteTurnId = null;
      clearRemoteCancelFallbackTimer();
      setPromptState("prompt_clean");
      if (mode === "remote_writer") {
        remotePromptText = null;
        if (remoteReclaimRequested) {
          void resumeLocalTerminal();
        } else {
          scheduleRemotePanelSettleRedraw();
          applyRemotePanelNotice();
        }
      }
    }
  }

  function subscribeEvents(): void {
    if (!server || !activityState) {
      return;
    }
    stopEvents = subscribeOpenCodeEvents({
      handle: server,
      onEvent: (event) => {
        if (!activityState) {
          return;
        }
        if (shouldSuppressCanceledRemoteEvent(event)) {
          return;
        }
        if (shouldIgnoreRemoteWriterFinalizedEvent(event)) {
          applyRemotePanelNotice();
          return;
        }
        if (shouldIgnoreRemoteWriterIdleBusyEvent(event)) {
          applyRemotePanelNotice();
          return;
        }
        attachRecentRemoteTurnToActivityState(event);
        for (const activity of translateOpenCodeEvent(activityState, event)) {
          publishActivity(activity);
        }
        if (event.type === "session.status") {
          applyRemotePanelNotice();
        }
      },
      onError: (error) => {
        if (!wrapperSessionId) {
          return;
        }
        send(socket, {
          type: "wrapper.activity",
          sessionId: wrapperSessionId,
          activity: {
            type: "runtime_status",
            status: "error",
            detail: error instanceof Error ? error.message : String(error),
          },
        });
      },
    });
  }

  async function startLocalTerminal(): Promise<void> {
    if (!server || !providerSessionId) {
      return;
    }
    mode = "local_native";
    remoteReclaimRequested = false;
    pendingRemoteTurn = null;
    remotePromptText = null;
    remoteTurnRequestInFlight = false;
    remoteTurnCancelRequested = false;
    remoteTurnFinalized = false;
    remoteTurnId = null;
    recentRemoteTurnId = null;
    recentRemoteTurnUntilMs = 0;
    suppressCanceledRemoteEvents = false;
    suppressCanceledRemoteEventsUntilMs = 0;
    clearRemoteCancelFallbackTimer();
    removeRemoteKeyboardHandler();
    leaveRemotePanel();
    restoreInheritedTerminalModes();
    const password = process.env.OPENCODE_SERVER_PASSWORD;
    const binary = await resolveOpenCodeBinary();
    localTerminal = new NativeTerminalProcess({
      cwd: args.cwd,
      command: binary,
      args: [
        "attach",
        server.baseUrl,
        "--dir",
        args.cwd,
        "--session",
        providerSessionId,
        ...(password ? ["--password", password] : []),
      ],
      onExit: (exit) => {
        localTerminal = null;
        restoreInheritedTerminalModes();
        if (!exiting && mode === "local_native") {
          void cleanup(exit);
        }
      },
    });
  }

  async function resumeLocalTerminal(): Promise<void> {
    await startLocalTerminal();
    setPromptState("prompt_clean");
  }

  async function collectOpenCodeAttachPids(): Promise<number[]> {
    if (!server || !providerSessionId || process.platform === "win32") {
      return [];
    }
    try {
      const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], {
        maxBuffer: 1024 * 1024,
      });
      const pids: number[] = [];
      for (const line of stdout.split("\n")) {
        const match = line.match(/^\s*(\d+)\s+(.+)$/);
        if (!match) {
          continue;
        }
        const pid = Number(match[1]);
        const command = match[2] ?? "";
        if (
          pid !== process.pid &&
          Number.isInteger(pid) &&
          command.includes("opencode attach") &&
          command.includes(server.baseUrl) &&
          command.includes(providerSessionId) &&
          command.includes(args.cwd)
        ) {
          pids.push(pid);
        }
      }
      return pids;
    } catch {
      return [];
    }
  }

  function killPids(pids: number[], signal: NodeJS.Signals): void {
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
      } catch {
        // Process already exited.
      }
    }
  }

  async function reapOpenCodeAttachProcesses(): Promise<void> {
    const pids = await collectOpenCodeAttachPids();
    if (pids.length === 0) {
      return;
    }
    killPids(pids, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const latePids = await collectOpenCodeAttachPids();
    killPids(latePids, "SIGKILL");
  }

  function removeRemoteKeyboardHandler(): void {
    const input = remoteKeyboardInput;
    if (remoteKeyboardHandler && input) {
      input.off("data", remoteKeyboardHandler);
      remoteKeyboardHandler = null;
    }
    clearRemoteKeyboardRawModeTimer();
    remoteSttyRawModeEnabled = false;
    setRemoteKeyboardRawMode(false);
    if (input && input !== process.stdin) {
      input.destroy();
    } else {
      process.stdin.pause();
    }
    remoteKeyboardInput = null;
    void restoreRemoteSttyMode();
  }

  function isMouseOrFocusInput(data: string): boolean {
    return (
      data.startsWith("\u001b[<") ||
      data.startsWith("\u001b[M") ||
      data === "\u001b[I" ||
      data === "\u001b[O"
    );
  }

  function isEscReclaimInput(data: string): boolean {
    return data === "\u001b" || data.startsWith("\u001b[27;");
  }

  function clearRemoteKeyboardRawModeTimer(): void {
    if (remoteKeyboardRawModeTimer) {
      clearInterval(remoteKeyboardRawModeTimer);
      remoteKeyboardRawModeTimer = null;
    }
  }

  function setRemoteKeyboardRawMode(enabled: boolean): void {
    const inputs = [remoteKeyboardInput, process.stdin as RemoteKeyboardInput].filter(
      (input, index, allInputs): input is RemoteKeyboardInput =>
        input !== null && allInputs.indexOf(input) === index,
    );
    for (const input of inputs) {
      try {
        input.setRawMode?.(enabled);
      } catch {
        // The inherited terminal can disappear while the native TUI is exiting.
      }
    }
  }

  async function captureRemoteSttyRestoreState(): Promise<void> {
    if (remoteSttyRestoreState !== null || process.platform === "win32") {
      return;
    }
    try {
      const { stdout } = await execFileAsync("sh", ["-lc", "stty -g < /dev/tty"], {
        maxBuffer: 16 * 1024,
      });
      const state = stdout.trim();
      if (/^[A-Za-z0-9:]+$/.test(state)) {
        remoteSttyRestoreState = state;
      }
    } catch {
      // Node raw mode is still attempted above.
    }
  }

  function requestRemoteSttyRawMode(): void {
    if (process.platform === "win32" || remoteSttyRawModeInFlight) {
      return;
    }
    const now = Date.now();
    if (now - lastRemoteSttyRawModeMs < REMOTE_STTY_RAW_REFRESH_MS) {
      return;
    }
    remoteSttyRawModeInFlight = true;
    void (async () => {
      await captureRemoteSttyRestoreState();
      if (!remoteSttyRawModeEnabled || exiting || mode !== "remote_writer") {
        return;
      }
      await execFileAsync("sh", ["-lc", "stty raw -echo min 1 time 0 < /dev/tty"], {
        maxBuffer: 16 * 1024,
      });
      lastRemoteSttyRawModeMs = Date.now();
    })()
      .catch(() => undefined)
      .finally(() => {
        remoteSttyRawModeInFlight = false;
      });
  }

  async function restoreRemoteSttyMode(): Promise<void> {
    const state = remoteSttyRestoreState;
    remoteSttyRestoreState = null;
    lastRemoteSttyRawModeMs = 0;
    if (!state || process.platform === "win32") {
      return;
    }
    try {
      await execFileAsync("sh", ["-lc", `stty ${state} < /dev/tty`], {
        maxBuffer: 16 * 1024,
      });
    } catch {
      // The terminal may already be gone during shutdown.
    }
  }

  function openRemoteKeyboardInput(): RemoteKeyboardInput {
    if (process.platform !== "win32") {
      try {
        const fd = fs.openSync("/dev/tty", "r");
        return new tty.ReadStream(fd) as RemoteKeyboardInput;
      } catch {
        // Fall back to inherited stdin below.
      }
    }
    return process.stdin as RemoteKeyboardInput;
  }

  function refreshRemoteKeyboardRawMode(): void {
    if (!remoteKeyboardHandler || !remoteKeyboardInput || exiting || mode !== "remote_writer") {
      return;
    }
    remoteKeyboardInput.resume();
    setRemoteKeyboardRawMode(true);
    requestRemoteSttyRawMode();
  }

  function startRemoteKeyboardRawModeTimer(): void {
    clearRemoteKeyboardRawModeTimer();
    remoteKeyboardRawModeTimer = setInterval(() => {
      refreshRemoteKeyboardRawMode();
    }, REMOTE_KEYBOARD_RAW_REFRESH_MS);
  }

  function installRemoteKeyboardHandler(): void {
    if (remoteKeyboardHandler || exiting) {
      return;
    }
    const input = openRemoteKeyboardInput();
    remoteKeyboardInput = input;
    remoteSttyRawModeEnabled = true;
    input.setEncoding("utf8");
    input.resume();
    setRemoteKeyboardRawMode(true);
    remoteKeyboardHandler = (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      if (text === "\u0003") {
        void cleanup({ signal: "SIGINT" });
        return;
      }
      if (isMouseOrFocusInput(text)) {
        return;
      }
      if (isEscReclaimInput(text)) {
        if (currentRemoteState().controlAvailable) {
          void resumeLocalTerminal();
          return;
        }
        remoteReclaimRequested = true;
        renderRemotePanel({ force: true });
      }
    };
    input.on("data", remoteKeyboardHandler);
    startRemoteKeyboardRawModeTimer();
  }

  function finishRemoteTurn(activity: ProviderActivity): void {
    if (remoteTurnFinalized) {
      return;
    }
    publishActivity(activity);
  }

  function requestRemoteTurnStop(): void {
    if (mode !== "remote_writer" || remoteTurnFinalized) {
      if (pendingRemoteTurn && !remoteTurnRequestInFlight) {
        pendingRemoteTurn = null;
        remotePromptText = null;
        setPromptState("prompt_clean");
        renderRemotePanel({ force: true });
      }
      return;
    }
    remoteTurnCancelRequested = true;
    pendingRemoteTurn = null;
    renderRemotePanel({ force: true });
    if (server && providerSessionId) {
      void abortOpenCodeSession({ handle: server, providerSessionId }).catch((error) => {
        if (!wrapperSessionId || !remoteTurnId || remoteTurnFinalized) {
          return;
        }
        send(socket, {
          type: "wrapper.activity",
          sessionId: wrapperSessionId,
          activity: {
            type: "runtime_status",
            status: "error",
            detail: error instanceof Error ? error.message : String(error),
            turnId: remoteTurnId,
          },
        });
      });
    }
    if (!remoteCancelFallbackTimer) {
      remoteCancelFallbackTimer = setTimeout(() => {
        remoteCancelFallbackTimer = null;
        if (!remoteTurnCancelRequested || remoteTurnFinalized || !remoteTurnId) {
          return;
        }
        finishRemoteTurn({
          type: "turn_canceled",
          turnId: remoteTurnId,
          reason: "Stop requested",
        });
      }, REMOTE_CANCEL_FALLBACK_MS);
    }
  }

  async function startRemoteTurn(turn: QueuedTurn): Promise<void> {
    if (!server || !providerSessionId || !activityState || remoteTurnRequestInFlight) {
      return;
    }
    pendingRemoteTurn = null;
    remotePromptText = turn.text;
    remoteTurnRequestInFlight = true;
    remoteTurnCancelRequested = false;
    remoteTurnFinalized = false;
    const turnId = randomUUID();
    remoteTurnId = turnId;
    recentRemoteTurnId = null;
    recentRemoteTurnUntilMs = 0;
    suppressCanceledRemoteEvents = false;
    suppressCanceledRemoteEventsUntilMs = 0;
    mode = "remote_writer";
    scheduleRemotePanelSettleRedraw();
    renderRemotePanel({ force: true });
    for (const activity of startOpenCodeTurn(activityState, turnId)) {
      publishActivity(activity);
    }
    publishActivity({
      type: "timeline_item",
      turnId,
      item: { kind: "user_message", text: turn.text },
    });
    setPromptState("agent_busy");
    const terminalToClose = localTerminal;
    localTerminal = null;
    if (terminalToClose) {
      await terminalToClose.close("SIGTERM").catch(() => undefined);
    }
    await reapOpenCodeAttachProcesses();
    installRemoteKeyboardHandler();
    refreshRemoteKeyboardRawMode();
    renderRemotePanel({ force: true });
    if (remoteTurnFinalized) {
      return;
    }
    if (remoteTurnCancelRequested) {
      finishRemoteTurn({
        type: "turn_canceled",
        turnId,
        reason: "Stop requested",
      });
      return;
    }
    try {
      await promptOpenCodeSessionAsync({
        handle: server,
        providerSessionId,
        text: turn.text,
      });
    } catch (error) {
      if (remoteTurnCancelRequested) {
        finishRemoteTurn({
          type: "turn_canceled",
          turnId,
          reason: "Stop requested",
        });
      } else {
        finishRemoteTurn({
          type: "turn_failed",
          turnId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    renderRemotePanel({ force: true });
  }

  async function initializeOpenCode(): Promise<void> {
    if (!wrapperSessionId) {
      return;
    }
    server = await startOpenCodeServer({ cwd: args.cwd });
    const session = args.resumeProviderSessionId
      ? await getOpenCodeSession(server, args.resumeProviderSessionId)
      : await createOpenCodeSession(server, { title: "OpenCode terminal session" });
    providerSessionId = session.id;
    activityState = createOpenCodeActivityState(session.id);
    send(socket, {
      type: "wrapper.provider_bound",
      sessionId: wrapperSessionId,
      providerSessionId: session.id,
      providerTitle: session.title,
      reason: args.resumeProviderSessionId ? "resume" : "initial",
    });
    subscribeEvents();
    await startLocalTerminal();
    setPromptState("prompt_clean");
  }

  async function cleanup(options?: { exitCode?: number; signal?: string }): Promise<void> {
    if (exiting) {
      return;
    }
    exiting = true;
    clearRemoteCancelFallbackTimer();
    clearRemotePanelSettleTimer();
    removeRemoteKeyboardHandler();
    leaveRemotePanel();
    restoreInheritedTerminalModes();
    const terminal = localTerminal;
    localTerminal = null;
    await terminal?.close("SIGTERM").catch(() => undefined);
    await reapOpenCodeAttachProcesses();
    stopEvents?.();
    stopEvents = null;
    if (server) {
      await stopOpenCodeServer(server).catch(() => undefined);
      server = null;
    }
    if (wrapperSessionId) {
      send(socket, {
        type: "wrapper.exited",
        sessionId: wrapperSessionId,
        ...(options?.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      });
    }
    socket.close();
  }

  socket.on("open", () => {
    send(socket, {
      type: "wrapper.hello",
      provider: "opencode",
      cwd: args.cwd,
      rootDir: args.cwd,
      terminalPid: process.pid,
      launchCommand: process.argv.slice(0),
      ...(args.resumeProviderSessionId ? { resumeProviderSessionId: args.resumeProviderSessionId } : {}),
    });
  });

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8")) as TerminalWrapperFromDaemonMessage;
    if (message.type === "wrapper.ready") {
      wrapperSessionId = message.sessionId;
      void initializeOpenCode().catch((error) => {
        if (wrapperSessionId) {
          send(socket, {
            type: "wrapper.activity",
            sessionId: wrapperSessionId,
            activity: {
              type: "session_failed",
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
        void cleanup({ exitCode: 1 });
      });
      return;
    }
    if (message.type === "turn.inject") {
      void startRemoteTurn(message.queuedTurn);
      return;
    }
    if (message.type === "turn.enqueue") {
      pendingRemoteTurn = message.queuedTurn;
      renderRemotePanel();
      return;
    }
    if (message.type === "turn.interrupt") {
      requestRemoteTurnStop();
      return;
    }
    if (message.type === "permission.resolve") {
      if (server) {
        const selected = message.response.selectedActionId;
        const reply = selected === "always" ? "always" : selected === "reject" ? "reject" : "once";
        void respondOpenCodePermission({
          handle: server,
          requestId: message.requestId,
          reply,
          ...(message.response.message ? { message: message.response.message } : {}),
        });
      }
      return;
    }
    if (message.type === "wrapper.close") {
      void cleanup();
    }
  });

  socket.on("close", () => {
    if (!exiting) {
      void cleanup({ exitCode: 1 });
    }
  });
  socket.on("error", (error) => {
    process.stderr.write(`[rah] ${error.message}\n`);
    void cleanup({ exitCode: 1 });
  });

  process.on("SIGINT", () => {
    void cleanup({ signal: "SIGINT" });
  });
  process.on("SIGTERM", () => {
    void cleanup({ signal: "SIGTERM" });
  });
  process.on("exit", () => {
    restoreInheritedTerminalModes();
  });
}

void main().catch((error) => {
  process.stderr.write(`[rah] ${error instanceof Error ? error.message : String(error)}\n`);
  restoreInheritedTerminalModes();
  process.exitCode = 1;
});
