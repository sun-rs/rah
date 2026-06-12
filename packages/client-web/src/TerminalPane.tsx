import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { closeNativeTuiClient, createPtySocket, getNativeTuiSurface, sendPtyMessage } from "./api";
import {
  mobileBridgeFocusOptionsForSource,
  type MobileBridgeFocusOptions,
} from "./terminal-mobile-bridge";
import { isTerminalProtocolResponse } from "./terminal-protocol-response";
import { shouldRequestPtyReplay } from "./terminal-pty-replay-policy";
import { ptySocketCloseNotice } from "./terminal-socket-close";
import { TERMINAL_TUI_SHORTCUTS, type TerminalShortcut } from "./terminal-shortcuts";
import { readTerminalViewportMetrics } from "./terminal-viewport";

export interface TerminalPaneProps {
  terminalId: string;
  clientId: string;
  hasControl: boolean;
  claimSurface?: boolean;
  autoFocus?: boolean;
  maxWriteBatchChars?: number;
  replayTailBytes?: number;
  scrollback?: number;
  tuiClientCloseEnabled?: boolean;
  onClose?: () => void;
  closeLabel?: string;
  closeTitle?: string;
  nativeSurfaceControl?: boolean;
  renderOutput?: boolean;
  tuiClientActive?: boolean;
  onTuiClientActiveChange?: (active: boolean) => void;
  initialReplay?: boolean;
}

type TerminalCssVar =
  | "--terminal-font-family"
  | "--terminal-bg"
  | "--terminal-fg"
  | "--terminal-muted"
  | "--terminal-cursor"
  | "--terminal-selection"
  | "--app-code-bg"
  | "--app-fg"
  | "--app-hint";

const DEFAULT_MAX_TERMINAL_WRITE_BATCH_CHARS = 128 * 1024;
const MAX_PAUSED_TERMINAL_OUTPUT_TAIL_CHARS = 256 * 1024;
const TERMINAL_INPUT_FLUSH_DELAY_MS = 2;
const TERMINAL_OUTPUT_FLUSH_DELAY_MS = 16;

function stripTerminalControlText(data: string): string {
  return data
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\r/g, "\n")
    .trim();
}

function isMeaningfulTerminalOutput(data: string): boolean {
  const text = stripTerminalControlText(data);
  return text.length > 0 && !/^\[rah\]\s+Starting\b/.test(text);
}

function shouldShowMobileInputBridge(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") {
    return false;
  }
  const userAgent = navigator.userAgent || "";
  const coarsePointer =
    window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(hover: none)").matches;
  const touchCapable = navigator.maxTouchPoints > 0 || "ontouchstart" in window || coarsePointer;
  const iosLike =
    /iPad|iPhone|iPod/.test(userAgent) ||
    (/Macintosh/.test(userAgent) && (navigator.maxTouchPoints > 1 || coarsePointer));
  const touchSmallScreen = touchCapable && window.matchMedia("(max-width: 768px)").matches;
  return iosLike || touchSmallScreen;
}

function commonPrefixLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function readCssVar(style: CSSStyleDeclaration, name: TerminalCssVar, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback;
}

export function readRahTerminalFontFamily(): string {
  if (typeof document === "undefined") {
    return "ui-monospace, monospace";
  }
  const style = getComputedStyle(document.documentElement);
  return readCssVar(
    style,
    "--terminal-font-family",
    '"SF Mono", Menlo, Monaco, "PingFang SC", "Hiragino Sans GB", ui-monospace, monospace',
  );
}

export function readRahTerminalTheme(): ITheme {
  if (typeof document === "undefined") {
    return {
      background: "#09090b",
      foreground: "#fafafa",
    };
  }
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const dark = root.classList.contains("dark") || root.dataset.theme === "dark";
  const background = readCssVar(style, "--terminal-bg", readCssVar(style, "--app-code-bg", "#09090b"));
  const foreground = readCssVar(style, "--terminal-fg", readCssVar(style, "--app-fg", "#fafafa"));
  const muted = readCssVar(style, "--terminal-muted", readCssVar(style, "--app-hint", "#a1a1aa"));
  const cursor = readCssVar(style, "--terminal-cursor", foreground);
  const selectionBackground = readCssVar(
    style,
    "--terminal-selection",
    dark ? "rgba(250, 250, 250, 0.18)" : "rgba(24, 24, 27, 0.16)",
  );

  return {
    background,
    foreground,
    cursor,
    cursorAccent: background,
    selectionBackground,
    black: dark ? "#18181b" : "#18181b",
    red: "#ef4444",
    green: "#22c55e",
    yellow: "#f59e0b",
    blue: "#3b82f6",
    magenta: "#d946ef",
    cyan: "#06b6d4",
    white: dark ? "#e4e4e7" : "#e4e4e7",
    brightBlack: muted,
    brightRed: "#f87171",
    brightGreen: "#4ade80",
    brightYellow: "#fbbf24",
    brightBlue: "#60a5fa",
    brightMagenta: "#e879f9",
    brightCyan: "#22d3ee",
    brightWhite: foreground,
  };
}

export function TerminalPane(props: TerminalPaneProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sendDataRef = useRef<(data: string, options?: { focusTerminal?: boolean }) => void>(() => undefined);
  const scheduleTerminalFitRef = useRef<(options?: { force?: boolean }) => void>(() => undefined);
  const fitTerminalImmediatelyRef = useRef<(options?: { force?: boolean }) => void>(() => undefined);
  const hasControlRef = useRef(props.hasControl);
  const claimSurfaceRef = useRef(props.claimSurface !== false);
  const nativeSurfaceControlRef = useRef(props.nativeSurfaceControl !== false);
  const renderOutputRef = useRef(props.renderOutput !== false);
  const autoFocusRef = useRef(props.autoFocus !== false);
  const surfaceActiveRef = useRef(false);
  const clientIdRef = useRef(props.clientId);
  const nextReplaySeqRef = useRef(0);
  const pausedOutputTailRef = useRef("");
  const pausedOutputReplaceRef = useRef(false);
  const pausedOutputSoftReplaceRef = useRef(false);
  const flushPausedOutputRef = useRef<() => void>(() => undefined);
  const terminalScrollRemainderRef = useRef(0);
  const touchScrollRef = useRef<{ identifier: number; lastY: number } | null>(null);
  const [showIosInputBridge, setShowIosInputBridge] = useState(false);
  const [bridgeValue, setBridgeValue] = useState("");
  const [keyboardInsetPx, setKeyboardInsetPx] = useState(0);
  const [terminalVisibleHeightPx, setTerminalVisibleHeightPx] = useState(0);
  const [terminalFixedTopPx, setTerminalFixedTopPx] = useState(0);
  const [terminalFixedLeftPx, setTerminalFixedLeftPx] = useState(0);
  const [terminalFixedWidthPx, setTerminalFixedWidthPx] = useState(0);
  const [surfaceOwnerKind, setSurfaceOwnerKind] = useState<string | null>(null);
  const [localTuiClientActive, setLocalTuiClientActive] = useState(true);
  const [tuiClientClosing, setTuiClientClosing] = useState(false);
  const [startupOverlayVisible, setStartupOverlayVisible] = useState(
    props.initialReplay === false,
  );
  const startupOverlayVisibleRef = useRef(props.initialReplay === false);
  const startupOverlayReleaseTimerRef = useRef<number | null>(null);
  const tuiClientCloseEnabled = props.tuiClientCloseEnabled === true;
  const tuiClientActive = tuiClientCloseEnabled
    ? props.tuiClientActive ?? localTuiClientActive
    : true;
  const showPanelCloseButton = tuiClientCloseEnabled ? tuiClientActive : Boolean(props.onClose);
  const committedBridgeValueRef = useRef("");
  const bridgeInputRef = useRef<HTMLInputElement | null>(null);
  const isComposingRef = useRef(false);

  const applyViewportMetrics = () => {
    const metrics = readTerminalViewportMetrics(shellRef.current);
    setKeyboardInsetPx(metrics.keyboardInsetPx);
    setTerminalVisibleHeightPx(metrics.visibleHeightPx);
    setTerminalFixedTopPx(metrics.panelTopPx);
    setTerminalFixedLeftPx(metrics.panelLeftPx);
    setTerminalFixedWidthPx(metrics.panelWidthPx);
    scheduleTerminalFitRef.current();
  };

  useEffect(() => {
    setShowIosInputBridge(shouldShowMobileInputBridge());
  }, []);

  const claimCurrentSurface = () => {
    if (!nativeSurfaceControlRef.current) {
      surfaceActiveRef.current = claimSurfaceRef.current;
      setSurfaceOwnerKind(null);
      return;
    }
    if (!claimSurfaceRef.current || !tuiClientActive) {
      return;
    }
    const socket = socketRef.current;
    const terminal = terminalRef.current;
    if (!socket || !terminal) {
      return;
    }
    fitAddonRef.current?.fit();
    terminal.refresh(0, Math.max(0, terminal.rows - 1));
    sendPtyMessage(socket, {
      type: "pty.surface.attach",
      sessionId: props.terminalId,
      clientId: clientIdRef.current,
      clientKind: "web",
      cols: terminal.cols,
      rows: terminal.rows,
    });
    surfaceActiveRef.current = true;
    setSurfaceOwnerKind(null);
  };

  const releaseCurrentSurface = () => {
    if (!nativeSurfaceControlRef.current) {
      surfaceActiveRef.current = false;
      setSurfaceOwnerKind(null);
      return;
    }
    if (socketRef.current && surfaceActiveRef.current) {
      sendPtyMessage(socketRef.current, {
        type: "pty.surface.detach",
        sessionId: props.terminalId,
        clientId: clientIdRef.current,
      });
    }
    surfaceActiveRef.current = false;
    setSurfaceOwnerKind(null);
  };

  useEffect(() => {
    hasControlRef.current = props.hasControl;
    if (props.hasControl && claimSurfaceRef.current) {
      scheduleTerminalFitRef.current({ force: true });
    }
  }, [props.hasControl]);

  useEffect(() => {
    claimSurfaceRef.current = props.claimSurface !== false;
    if (!nativeSurfaceControlRef.current) {
      surfaceActiveRef.current = claimSurfaceRef.current;
      setSurfaceOwnerKind(null);
      return;
    }
    if (claimSurfaceRef.current) {
      claimCurrentSurface();
      flushPausedOutputRef.current();
      scheduleTerminalFitRef.current({ force: true });
      terminalRef.current?.refresh(0, Math.max(0, terminalRef.current.rows - 1));
    } else {
      releaseCurrentSurface();
    }
  }, [props.claimSurface]);

  useEffect(() => {
    nativeSurfaceControlRef.current = props.nativeSurfaceControl !== false;
    if (!nativeSurfaceControlRef.current) {
      surfaceActiveRef.current = claimSurfaceRef.current;
      setSurfaceOwnerKind(null);
    }
  }, [props.nativeSurfaceControl]);

  useEffect(() => {
    const wasRendering = renderOutputRef.current;
    renderOutputRef.current = props.renderOutput !== false;
    if (!wasRendering && renderOutputRef.current) {
      fitTerminalImmediatelyRef.current();
      flushPausedOutputRef.current();
      scheduleTerminalFitRef.current({ force: true });
    }
  }, [props.renderOutput]);

  useEffect(() => {
    const wasAutoFocusEnabled = autoFocusRef.current;
    const nextAutoFocusEnabled = props.autoFocus !== false;
    autoFocusRef.current = nextAutoFocusEnabled;
    if (wasAutoFocusEnabled || !nextAutoFocusEnabled || showIosInputBridge) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      terminalRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [props.autoFocus, showIosInputBridge]);

  useEffect(() => {
    clientIdRef.current = props.clientId;
  }, [props.clientId]);

  useEffect(() => {
    if (props.tuiClientActive === undefined) {
      setLocalTuiClientActive(true);
    }
    setTuiClientClosing(false);
    setSurfaceOwnerKind(null);
    nextReplaySeqRef.current = 0;
    const showStartupOverlay = props.initialReplay === false && tuiClientActive;
    startupOverlayVisibleRef.current = showStartupOverlay;
    setStartupOverlayVisible(showStartupOverlay);
  }, [props.terminalId, props.tuiClientActive]);

  useEffect(() => {
    const showStartupOverlay = props.initialReplay === false && tuiClientActive;
    startupOverlayVisibleRef.current = showStartupOverlay;
    setStartupOverlayVisible(showStartupOverlay);
  }, [props.initialReplay, tuiClientActive]);

  const setTuiClientActiveState = (active: boolean) => {
    props.onTuiClientActiveChange?.(active);
    if (props.tuiClientActive === undefined) {
      setLocalTuiClientActive(active);
    }
  };

  const releaseStartupOverlaySoon = () => {
    if (!startupOverlayVisibleRef.current || startupOverlayReleaseTimerRef.current) {
      return;
    }
    startupOverlayReleaseTimerRef.current = window.setTimeout(() => {
      startupOverlayReleaseTimerRef.current = null;
      startupOverlayVisibleRef.current = false;
      setStartupOverlayVisible(false);
    }, 180);
  };

  useEffect(() => {
    if (!showIosInputBridge || typeof window === "undefined") {
      setKeyboardInsetPx(0);
      setTerminalVisibleHeightPx(0);
      setTerminalFixedTopPx(0);
      setTerminalFixedLeftPx(0);
      setTerminalFixedWidthPx(0);
      return;
    }
    let frame: number | null = null;
    const update = () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      frame = window.requestAnimationFrame(() => {
        frame = null;
        applyViewportMetrics();
      });
    };

    update();
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, [showIosInputBridge]);

  useEffect(() => {
    scheduleTerminalFitRef.current();
  }, [keyboardInsetPx, terminalVisibleHeightPx]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !tuiClientActive) {
      return;
    }
    let disposed = false;
    let exited = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let surfacePollTimer: ReturnType<typeof setInterval> | null = null;
    const settleTimers = new Set<number>();
    let fitFrame: number | null = null;
    let forceNextResize = false;
    let writeScheduled = false;
    let writeInFlight = false;
    let pendingWrite = "";
    let pendingReplace: string | null = null;
    let pendingReplaceSoft = false;
    let pendingInput = "";
    let inputFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const nativeSurfaceControlEnabled = props.nativeSurfaceControl !== false;
    nextReplaySeqRef.current = 0;
    pausedOutputTailRef.current = "";
    pausedOutputReplaceRef.current = false;
    pausedOutputSoftReplaceRef.current = false;
    surfaceActiveRef.current = !nativeSurfaceControlEnabled;

    const terminalOptions = {
      convertEol: false,
      disableStdin: showIosInputBridge,
      fontFamily: readRahTerminalFontFamily(),
      fontSize: showIosInputBridge ? 12 : 13,
      letterSpacing: 0,
      lineHeight: showIosInputBridge ? 1.12 : 1.1,
      theme: readRahTerminalTheme(),
      ...(props.scrollback !== undefined ? { scrollback: props.scrollback } : {}),
    };
    const terminal = new Terminal(terminalOptions);
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    if (autoFocusRef.current && !showIosInputBridge) {
      terminal.focus();
    }
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const fitAndNotifyResize = (options?: { force?: boolean }) => {
      fitFrame = null;
      const forceResize = forceNextResize || options?.force === true;
      forceNextResize = false;
      const previousCols = terminal.cols;
      const previousRows = terminal.rows;
      fitAddon.fit();
      if (showIosInputBridge) {
        terminal.scrollToBottom();
      }
      if (forceResize || previousCols !== terminal.cols || previousRows !== terminal.rows) {
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
      }
      if (
        previousCols === terminal.cols &&
        previousRows === terminal.rows &&
        !forceResize
      ) {
        return;
      }
      if (nativeSurfaceControlEnabled && !claimSurfaceRef.current) {
        return;
      }
      if (!socketRef.current) {
        return;
      }
      sendPtyMessage(socketRef.current, {
        type: "pty.resize",
        sessionId: props.terminalId,
        clientId: clientIdRef.current,
        cols: terminal.cols,
        rows: terminal.rows,
      });
    };

    const fitImmediatelyAndNotifyResize = (options?: { force?: boolean }) => {
      if (fitFrame !== null) {
        window.cancelAnimationFrame(fitFrame);
        fitFrame = null;
      }
      fitAndNotifyResize(options);
    };

    const scheduleFitAndResize = (options?: { force?: boolean }) => {
      if (options?.force) {
        forceNextResize = true;
      }
      if (fitFrame !== null) {
        window.cancelAnimationFrame(fitFrame);
      }
      fitFrame = window.requestAnimationFrame(() => fitAndNotifyResize());
    };
    scheduleTerminalFitRef.current = scheduleFitAndResize;
    fitTerminalImmediatelyRef.current = fitImmediatelyAndNotifyResize;

    const settleTerminalLayout = () => {
      scheduleFitAndResize({ force: true });
      if (!nativeSurfaceControlEnabled) {
        return;
      }
      window.requestAnimationFrame(() => {
        if (disposed) {
          return;
        }
        scheduleFitAndResize({ force: true });
        window.requestAnimationFrame(() => {
          if (disposed) {
            return;
          }
          scheduleFitAndResize({ force: true });
        });
      });
      for (const delay of [80, 160]) {
        const timer = window.setTimeout(() => {
          settleTimers.delete(timer);
          if (disposed) {
            return;
          }
          scheduleFitAndResize({ force: true });
          terminal.refresh(0, Math.max(0, terminal.rows - 1));
        }, delay);
        settleTimers.add(timer);
      }
    };

    settleTerminalLayout();

    const applyTheme = () => {
      terminal.options.fontFamily = readRahTerminalFontFamily();
      terminal.options.theme = readRahTerminalTheme();
    };
    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });

    const connect = (fromSeq?: number) => {
      const scheduleTerminalWrite = () => {
        if (writeInFlight) {
          return;
        }
        if (writeScheduled) {
          return;
        }
        writeScheduled = true;
        window.setTimeout(() => {
          writeScheduled = false;
          if (disposed || writeInFlight || (pendingReplace === null && pendingWrite.length === 0)) {
            return;
          }
          if (pendingReplace !== null) {
            fitImmediatelyAndNotifyResize();
          }
          let chunk: string;
          if (pendingReplace !== null) {
            if (pendingReplaceSoft) {
              // tmux snapshot streams replace the visible terminal frequently while
              // Claude/Gemini are animating. A full xterm reset on every snapshot
              // visibly flashes; a soft screen replacement keeps terminal state
              // stable while still presenting the latest captured frame.
              chunk = `\u001b[H\u001b[2J${pendingReplace}`;
            } else {
              chunk = pendingReplace;
              terminal.reset();
            }
            pendingReplace = null;
            pendingReplaceSoft = false;
            pendingWrite = "";
          } else {
            const maxWriteBatchChars = Math.max(
              16 * 1024,
              props.maxWriteBatchChars ?? DEFAULT_MAX_TERMINAL_WRITE_BATCH_CHARS,
            );
            chunk = pendingWrite.slice(0, maxWriteBatchChars);
            pendingWrite = pendingWrite.slice(chunk.length);
          }
          writeInFlight = true;
          terminal.write(chunk, () => {
            writeInFlight = false;
            if (!disposed && (pendingReplace !== null || pendingWrite.length > 0)) {
              scheduleTerminalWrite();
            }
          });
        }, TERMINAL_OUTPUT_FLUSH_DELAY_MS);
      };

      const enqueueTerminalWrite = (data: string) => {
        if (!data) {
          return;
        }
        pendingWrite += data;
        scheduleTerminalWrite();
      };

      const storePausedTerminalOutput = (
        data: string,
        options?: { replace?: boolean; softReplace?: boolean },
      ) => {
        if (!data) {
          return;
        }
        if (options?.replace) {
          pausedOutputTailRef.current = data.slice(-MAX_PAUSED_TERMINAL_OUTPUT_TAIL_CHARS);
          pausedOutputReplaceRef.current = true;
          pausedOutputSoftReplaceRef.current = options.softReplace === true;
          return;
        }
        pausedOutputTailRef.current = `${pausedOutputTailRef.current}${data}`.slice(
          -MAX_PAUSED_TERMINAL_OUTPUT_TAIL_CHARS,
        );
      };

      const clearPendingTerminalWrite = () => {
        pendingWrite = "";
        pendingReplace = null;
        pendingReplaceSoft = false;
      };

      const replaceTerminalContents = (data: string, options?: { soft?: boolean }) => {
        clearPendingTerminalWrite();
        pendingReplace = data;
        pendingReplaceSoft = options?.soft === true;
        scheduleTerminalWrite();
      };

      const enqueueVisibleTerminalWrite = (
        data: string,
        options?: { replace?: boolean; softReplace?: boolean },
      ) => {
        if (
          startupOverlayVisibleRef.current &&
          !options?.replace &&
          isMeaningfulTerminalOutput(data)
        ) {
          releaseStartupOverlaySoon();
        }
        if (renderOutputRef.current) {
          if (options?.replace) {
            replaceTerminalContents(
              data,
              options.softReplace === undefined ? undefined : { soft: options.softReplace },
            );
          } else {
            enqueueTerminalWrite(data);
          }
          return;
        }
        storePausedTerminalOutput(data, options);
      };

      flushPausedOutputRef.current = () => {
        const data = pausedOutputTailRef.current;
        if (!data) {
          return;
        }
        const replace = pausedOutputReplaceRef.current;
        const softReplace = pausedOutputSoftReplaceRef.current;
        pausedOutputTailRef.current = "";
        pausedOutputReplaceRef.current = false;
        pausedOutputSoftReplaceRef.current = false;
        if (replace) {
          replaceTerminalContents(data, { soft: softReplace });
        } else {
          enqueueTerminalWrite(data);
        }
      };

      const socket = createPtySocket(
        props.terminalId,
        (message) => {
        if (message.type === "pty.replay") {
          if (fromSeq === undefined || message.droppedBeforeSeq !== undefined) {
            enqueueVisibleTerminalWrite(message.chunks.join(""), { replace: true });
          } else {
            enqueueVisibleTerminalWrite(message.chunks.join(""));
          }
          scheduleFitAndResize();
          if (message.nextSeq !== undefined) {
            nextReplaySeqRef.current = message.nextSeq;
          }
          return;
        }
        if (message.type === "pty.output") {
          if (message.replace === true) {
            enqueueVisibleTerminalWrite(message.data, { replace: true, softReplace: true });
          } else {
            enqueueVisibleTerminalWrite(message.data);
          }
          if (message.seq !== undefined) {
            nextReplaySeqRef.current = Math.max(nextReplaySeqRef.current, message.seq + 1);
          }
          return;
        }
        if (message.type === "pty.exited") {
          exited = true;
          if (message.seq !== undefined) {
            nextReplaySeqRef.current = Math.max(nextReplaySeqRef.current, message.seq + 1);
          }
          enqueueVisibleTerminalWrite(
            `\r\n[session exited${message.exitCode !== undefined ? ` code=${message.exitCode}` : ""}]\r\n`,
          );
        }
      },
      (error) => {
        if (error.message === "PTY socket failed") {
          return;
        }
        enqueueVisibleTerminalWrite(`\r\n[pty error] ${error.message}\r\n`);
      },
        {
          ...(fromSeq !== undefined ? { fromSeq } : {}),
          replay: shouldRequestPtyReplay({
            initialReplay: props.initialReplay !== false,
            ...(fromSeq !== undefined ? { fromSeq } : {}),
          }),
          ...(props.replayTailBytes !== undefined
            ? { replayTailBytes: props.replayTailBytes }
            : {}),
        },
      );
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        reconnectAttempt = 0;
        claimCurrentSurface();
        settleTerminalLayout();
      });
      scheduleFitAndResize({ force: true });
      socket.addEventListener("close", (event) => {
        const isCurrentSocket = socketRef.current === socket;
        if (!isCurrentSocket) {
          return;
        }
        socketRef.current = null;
        if (disposed || exited) {
          return;
        }
        const closeNotice = ptySocketCloseNotice(event.code, event.reason);
        if (closeNotice) {
          enqueueTerminalWrite(`\r\n${closeNotice}\r\n`);
        }
        const reconnectDelayMs = Math.min(30_000, 1_000 * 2 ** reconnectAttempt);
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(() => {
          connect(nextReplaySeqRef.current);
        }, reconnectDelayMs);
      });
    };

    connect();
    if (nativeSurfaceControlEnabled) {
      surfacePollTimer = setInterval(() => {
        if (!claimSurfaceRef.current) {
          return;
        }
        void getNativeTuiSurface(props.terminalId)
          .then((response) => {
            if (disposed) {
              return;
            }
            const surface = response.surface;
            if (!surface) {
              claimCurrentSurface();
              return;
            }
            if (surface.clientId === clientIdRef.current) {
              surfaceActiveRef.current = true;
              setSurfaceOwnerKind(null);
              return;
            }
            surfaceActiveRef.current = false;
            setSurfaceOwnerKind(surface.clientKind);
          })
          .catch(() => undefined);
      }, 1_000);
    }

    const sendPtyInputNow = (data: string) => {
      const socket = socketRef.current;
      if (!socket) {
        return;
      }
      sendPtyMessage(socket, {
        type: "pty.input",
        sessionId: props.terminalId,
        clientId: clientIdRef.current,
        data,
      });
    };

    const flushPendingInput = () => {
      if (inputFlushTimer) {
        clearTimeout(inputFlushTimer);
        inputFlushTimer = null;
      }
      if (!pendingInput) {
        return;
      }
      const data = pendingInput;
      pendingInput = "";
      sendPtyInputNow(data);
    };

    const enqueuePtyInput = (data: string) => {
      pendingInput += data;
      if (data.includes("\r") || data.includes("\n") || data.includes("\u0003") || data.includes("\u0004")) {
        flushPendingInput();
        return;
      }
      if (!inputFlushTimer) {
        inputFlushTimer = setTimeout(flushPendingInput, TERMINAL_INPUT_FLUSH_DELAY_MS);
      }
    };

    sendDataRef.current = (data: string, options?: { focusTerminal?: boolean }) => {
      if (!data) {
        return;
      }
      if (
        !claimSurfaceRef.current ||
        !hasControlRef.current ||
        !socketRef.current
      ) {
        return;
      }
      if (nativeSurfaceControlRef.current && !surfaceActiveRef.current) {
        return;
      }
      enqueuePtyInput(data);
      if (options?.focusTerminal !== false && autoFocusRef.current && !showIosInputBridge) {
        terminal.focus();
      }
    };

    const disposable = terminal.onData((data) => {
      if (!claimSurfaceRef.current) {
        return;
      }
      if (!hasControlRef.current && isTerminalProtocolResponse(data)) {
        sendPtyInputNow(data);
        return;
      }
      if (!hasControlRef.current) {
        return;
      }
      sendDataRef.current(data, { focusTerminal: false });
    });

    const resizeObserver = new ResizeObserver(() => scheduleFitAndResize());
    resizeObserver.observe(container);
    if (panelRef.current) {
      resizeObserver.observe(panelRef.current);
    }

    return () => {
      disposed = true;
      surfaceActiveRef.current = false;
      if (fitFrame !== null) {
        window.cancelAnimationFrame(fitFrame);
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      if (inputFlushTimer) {
        clearTimeout(inputFlushTimer);
        inputFlushTimer = null;
      }
      if (startupOverlayReleaseTimerRef.current) {
        window.clearTimeout(startupOverlayReleaseTimerRef.current);
        startupOverlayReleaseTimerRef.current = null;
      }
      flushPendingInput();
      if (surfacePollTimer) {
        clearInterval(surfacePollTimer);
      }
      for (const timer of settleTimers) {
        window.clearTimeout(timer);
      }
      settleTimers.clear();
      pausedOutputTailRef.current = "";
      pausedOutputReplaceRef.current = false;
      pausedOutputSoftReplaceRef.current = false;
      flushPausedOutputRef.current = () => undefined;
      themeObserver.disconnect();
      resizeObserver.disconnect();
      disposable.dispose();
      if (socketRef.current) {
        if (nativeSurfaceControlEnabled) {
          sendPtyMessage(socketRef.current, {
            type: "pty.surface.detach",
            sessionId: props.terminalId,
            clientId: clientIdRef.current,
          });
        }
        socketRef.current.close();
      }
      terminal.dispose();
      socketRef.current = null;
      terminalRef.current = null;
      fitAddonRef.current = null;
      sendDataRef.current = () => undefined;
      scheduleTerminalFitRef.current = () => undefined;
      fitTerminalImmediatelyRef.current = () => undefined;
    };
  }, [props.terminalId, props.nativeSurfaceControl, showIosInputBridge, tuiClientActive]);

  const closeCurrentTuiClient = () => {
    if (tuiClientClosing) {
      return;
    }
    setTuiClientClosing(true);
    releaseCurrentSurface();
    setTuiClientActiveState(false);
    surfaceActiveRef.current = false;
    setSurfaceOwnerKind(null);
    void closeNativeTuiClient(props.terminalId, { clientId: clientIdRef.current })
      .catch(() => undefined)
      .finally(() => {
        setTuiClientClosing(false);
      });
  };

  const closePanel = () => {
    if (tuiClientCloseEnabled) {
      closeCurrentTuiClient();
      return;
    }
    props.onClose?.();
  };

  const activateCurrentTuiClient = () => {
    nextReplaySeqRef.current = 0;
    surfaceActiveRef.current = false;
    setSurfaceOwnerKind(null);
    setTuiClientActiveState(true);
  };

  const applyBridgeDelta = (nextValue: string) => {
    const previous = committedBridgeValueRef.current;
    const prefixLength = commonPrefixLength(previous, nextValue);
    const removedCount = previous.length - prefixLength;
    const inserted = nextValue.slice(prefixLength);

    if (removedCount > 0) {
      sendDataRef.current("\u007f".repeat(removedCount), { focusTerminal: false });
    }
    if (inserted) {
      sendDataRef.current(inserted, { focusTerminal: false });
    }
    committedBridgeValueRef.current = nextValue;
    setBridgeValue(nextValue);
  };

  const syncMobileBridgePosition = (
    scrollBlock: ScrollLogicalPosition = "nearest",
    allowBrowserScroll = false,
  ) => {
    const input = bridgeInputRef.current;
    if (!input) {
      return;
    }
    applyViewportMetrics();
    if (allowBrowserScroll) {
      panelRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
      input.scrollIntoView({ block: scrollBlock, inline: "nearest" });
    }
  };

  const focusMobileBridge = (options: MobileBridgeFocusOptions = {}) => {
    const input = bridgeInputRef.current;
    if (!input) {
      return;
    }
    const scrollBlock = options.scrollBlock ?? (options.allowBrowserScroll ? "center" : "nearest");
    try {
      if (options.allowBrowserScroll) {
        input.focus();
      } else {
        input.focus({ preventScroll: true });
      }
    } catch {
      input.focus();
    }
    const syncPosition = () => syncMobileBridgePosition(scrollBlock, options.allowBrowserScroll === true);
    window.requestAnimationFrame(syncPosition);
    window.setTimeout(syncPosition, 180);
    window.setTimeout(syncPosition, 420);
  };

  const sendTerminalShortcut = (
    shortcut: TerminalShortcut,
    options: { keepMobileBridgeFocused?: boolean } = {},
  ) => {
    sendDataRef.current(shortcut.data, { focusTerminal: !options.keepMobileBridgeFocused });
    if (shortcut.clearBridge) {
      committedBridgeValueRef.current = "";
      setBridgeValue("");
    }
    if (options.keepMobileBridgeFocused) {
      focusMobileBridge(mobileBridgeFocusOptionsForSource("shortcut"));
    }
  };

  const keyboardActive = showIosInputBridge && keyboardInsetPx > 0;
  const terminalScrollLinePx = () => {
    const terminal = terminalRef.current;
    const fontSize = typeof terminal?.options.fontSize === "number" ? terminal.options.fontSize : 13;
    const lineHeight = typeof terminal?.options.lineHeight === "number" ? terminal.options.lineHeight : 1.1;
    return Math.max(10, fontSize * lineHeight);
  };
  const scrollTerminalByPixels = (deltaY: number): boolean => {
    const terminal = terminalRef.current;
    if (!terminal || !Number.isFinite(deltaY) || deltaY === 0) {
      return false;
    }
    const linePx = terminalScrollLinePx();
    terminalScrollRemainderRef.current += deltaY;
    const lines = Math.trunc(terminalScrollRemainderRef.current / linePx);
    if (lines === 0) {
      return true;
    }
    terminalScrollRemainderRef.current -= lines * linePx;
    terminal.scrollLines(lines);
    return true;
  };
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const handleWheel = (event: WheelEvent) => {
      if (!tuiClientActive) {
        return;
      }
      const linePx = terminalScrollLinePx();
      const deltaY =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * linePx
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? event.deltaY * linePx * Math.max(1, terminalRef.current?.rows ?? 24)
            : event.deltaY;
      if (scrollTerminalByPixels(deltaY)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    container.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel, { capture: true });
    };
  }, [tuiClientActive]);

  const handleTerminalTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (!tuiClientActive || event.touches.length !== 1) {
      touchScrollRef.current = null;
      return;
    }
    const touch = event.touches.item(0);
    if (!touch) {
      touchScrollRef.current = null;
      return;
    }
    touchScrollRef.current = { identifier: touch.identifier, lastY: touch.clientY };
  };
  const handleTerminalTouchMove = (event: ReactTouchEvent<HTMLDivElement>) => {
    const activeTouch = touchScrollRef.current;
    if (!tuiClientActive || !activeTouch) {
      return;
    }
    let touch: { identifier: number; clientY: number } | null = null;
    for (let index = 0; index < event.touches.length; index += 1) {
      const candidate = event.touches.item(index);
      if (candidate?.identifier === activeTouch.identifier) {
        touch = candidate;
        break;
      }
    }
    if (!touch) {
      touchScrollRef.current = null;
      return;
    }
    const deltaY = activeTouch.lastY - touch.clientY;
    touchScrollRef.current = { identifier: activeTouch.identifier, lastY: touch.clientY };
    if (scrollTerminalByPixels(deltaY)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const clearTerminalTouchScroll = () => {
    touchScrollRef.current = null;
  };

  return (
    <div
      ref={shellRef}
      className={`terminal-panel-shell${showIosInputBridge ? " terminal-panel-with-ios-bridge" : ""}${
        keyboardActive ? " terminal-panel-keyboard-active" : ""
      }`}
      style={
        showIosInputBridge
          ? ({
              "--terminal-keyboard-inset": `${keyboardInsetPx}px`,
              "--terminal-visible-height": `${terminalVisibleHeightPx}px`,
              "--terminal-fixed-top": `${terminalFixedTopPx}px`,
              "--terminal-fixed-left": `${terminalFixedLeftPx}px`,
              "--terminal-fixed-width":
                terminalFixedWidthPx > 0 ? `${terminalFixedWidthPx}px` : "calc(100vw - 1.1rem)",
            } as CSSProperties)
          : undefined
      }
      data-mobile-input-bridge={showIosInputBridge ? "true" : undefined}
    >
      <div ref={panelRef} className="terminal-panel" data-testid="terminal-panel">
        {showPanelCloseButton ? (
          <button
            type="button"
            className="terminal-client-close-button"
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={closePanel}
            aria-label={
              tuiClientCloseEnabled
                ? "Close Web TUI client"
                : props.closeLabel ?? "Close terminal"
            }
            title={
              tuiClientCloseEnabled
                ? "Close this Web TUI client without stopping the running session"
                : props.closeTitle ?? "Close terminal"
            }
            disabled={tuiClientCloseEnabled ? tuiClientClosing : false}
          >
            <span aria-hidden="true" className="terminal-client-close-icon" />
          </button>
        ) : null}
        {!showIosInputBridge ? (
          <div className="terminal-desktop-shortcut-bar" aria-label="TUI shortcut keys">
            {TERMINAL_TUI_SHORTCUTS.map((shortcut) => (
              <button
                key={shortcut.label}
                type="button"
                className="terminal-desktop-shortcut"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => sendTerminalShortcut(shortcut)}
                aria-label={shortcut.ariaLabel ?? shortcut.label}
                title={`Send ${shortcut.ariaLabel ?? shortcut.label}`}
              >
                {shortcut.label}
              </button>
            ))}
          </div>
        ) : null}
        <div
          ref={containerRef}
          className="terminal-canvas"
          data-testid="terminal-canvas"
          onTouchStart={handleTerminalTouchStart}
          onTouchMove={handleTerminalTouchMove}
          onTouchEnd={clearTerminalTouchScroll}
          onTouchCancel={clearTerminalTouchScroll}
          onFocusCapture={
            showIosInputBridge
              ? (event) => {
                  const target = event.target;
                  if (
                    target instanceof HTMLTextAreaElement &&
                    target.classList.contains("xterm-helper-textarea")
                  ) {
                    event.stopPropagation();
                    target.blur();
                  }
                }
              : undefined
          }
        />
        {tuiClientCloseEnabled && !tuiClientActive ? (
          <div className="terminal-surface-overlay" data-testid="terminal-client-inactive-overlay">
            <div className="terminal-surface-overlay-card">
              <div className="terminal-surface-overlay-title">Web TUI client is closed</div>
              <div className="terminal-surface-overlay-copy">
                The session is still running. Activate only when you need the full native TUI.
              </div>
              <button
                type="button"
                className="terminal-surface-overlay-button"
                onClick={activateCurrentTuiClient}
              >
                Activate TUI
              </button>
            </div>
          </div>
        ) : null}
        {startupOverlayVisible && tuiClientActive ? (
          <div className="terminal-surface-overlay" data-testid="terminal-startup-overlay">
            <div className="terminal-surface-overlay-card">
              <div className="terminal-surface-overlay-title">Starting TUI</div>
              <div className="terminal-surface-overlay-copy">
                Waiting for the native terminal to draw its current screen.
              </div>
            </div>
          </div>
        ) : null}
        {surfaceOwnerKind ? (
          <div className="terminal-surface-overlay" data-testid="terminal-surface-overlay">
            <div className="terminal-surface-overlay-card">
              <div className="terminal-surface-overlay-title">TUI active on {surfaceOwnerKind}</div>
              <div className="terminal-surface-overlay-copy">
                Reclaiming here will detach the other tmux viewer.
              </div>
              <button type="button" className="terminal-surface-overlay-button" onClick={claimCurrentSurface}>
                Reattach here
              </button>
            </div>
          </div>
        ) : null}
        {showIosInputBridge ? (
          <div className="terminal-ios-input-bridge" data-testid="terminal-ios-input-bridge">
            <div className="terminal-ios-shortcut-row" aria-label="TUI shortcut keys">
              {TERMINAL_TUI_SHORTCUTS.map((shortcut) => (
                <button
                  key={shortcut.label}
                  type="button"
                  className="terminal-ios-shortcut"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => sendTerminalShortcut(shortcut, { keepMobileBridgeFocused: true })}
                  aria-label={shortcut.ariaLabel ?? shortcut.label}
                >
                  {shortcut.label}
                </button>
              ))}
            </div>
            <input
              ref={bridgeInputRef}
              type="text"
              value={bridgeValue}
              onChange={(event) => {
                if (isComposingRef.current) {
                  setBridgeValue(event.target.value);
                  return;
                }
                if (event.target.value === committedBridgeValueRef.current) {
                  return;
                }
                applyBridgeDelta(event.target.value);
              }}
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={(event) => {
                isComposingRef.current = false;
                applyBridgeDelta(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  sendDataRef.current("\r", { focusTerminal: false });
                  committedBridgeValueRef.current = "";
                  setBridgeValue("");
                  return;
                }
                if (event.key === "Backspace" && committedBridgeValueRef.current.length === 0) {
                  event.preventDefault();
                  sendDataRef.current("\u007f", { focusTerminal: false });
                  return;
                }
              }}
              onFocus={() => syncMobileBridgePosition("nearest")}
              placeholder="Tap here to type with your keyboard"
              className="terminal-ios-input"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              enterKeyHint="enter"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
