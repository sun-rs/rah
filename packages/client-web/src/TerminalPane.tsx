import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { createPtySocket, sendPtyMessage } from "./api";
import {
  mobileBridgeFocusOptionsForSource,
  type MobileBridgeFocusOptions,
} from "./terminal-mobile-bridge";
import { ptySocketCloseNotice } from "./terminal-socket-close";
import { readTerminalViewportMetrics } from "./terminal-viewport";

interface TerminalPaneProps {
  terminalId: string;
  clientId: string;
  hasControl: boolean;
}

type MobileTuiShortcut = {
  label: string;
  data: string;
  clearBridge?: boolean;
  ariaLabel?: string;
};

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

const MOBILE_TUI_SHORTCUTS: readonly MobileTuiShortcut[] = [
  { label: "Ctrl-C", data: "\u0003", clearBridge: true },
  { label: "Esc", data: "\u001b", clearBridge: true },
  { label: "Tab", data: "\t" },
  { label: "↑", data: "\u001b[A", ariaLabel: "Arrow up" },
  { label: "↓", data: "\u001b[B", ariaLabel: "Arrow down" },
  { label: "←", data: "\u001b[D", ariaLabel: "Arrow left" },
  { label: "→", data: "\u001b[C", ariaLabel: "Arrow right" },
  { label: "Enter", data: "\r", clearBridge: true },
];

const MAX_TERMINAL_WRITE_BATCH_CHARS = 256 * 1024;

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

function readRahTerminalFontFamily(): string {
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

function readRahTerminalTheme(): ITheme {
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
  const hasControlRef = useRef(props.hasControl);
  const clientIdRef = useRef(props.clientId);
  const nextReplaySeqRef = useRef(0);
  const [showIosInputBridge, setShowIosInputBridge] = useState(false);
  const [bridgeValue, setBridgeValue] = useState("");
  const [keyboardInsetPx, setKeyboardInsetPx] = useState(0);
  const [terminalVisibleHeightPx, setTerminalVisibleHeightPx] = useState(0);
  const [terminalFixedTopPx, setTerminalFixedTopPx] = useState(0);
  const [terminalFixedLeftPx, setTerminalFixedLeftPx] = useState(0);
  const [terminalFixedWidthPx, setTerminalFixedWidthPx] = useState(0);
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

  useEffect(() => {
    hasControlRef.current = props.hasControl;
    if (props.hasControl) {
      scheduleTerminalFitRef.current({ force: true });
    }
  }, [props.hasControl]);

  useEffect(() => {
    clientIdRef.current = props.clientId;
  }, [props.clientId]);

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
    if (!container) {
      return;
    }
    let disposed = false;
    let exited = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let fitFrame: number | null = null;
    let forceNextResize = false;
    let writeFrame: number | null = null;
    let pendingWrite = "";
    nextReplaySeqRef.current = 0;

    const terminal = new Terminal({
      convertEol: false,
      disableStdin: showIosInputBridge,
      fontFamily: readRahTerminalFontFamily(),
      fontSize: showIosInputBridge ? 12 : 13,
      letterSpacing: 0,
      lineHeight: showIosInputBridge ? 1.12 : 1.1,
      theme: readRahTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    if (!showIosInputBridge) {
      terminal.focus();
    }
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const fitAndNotifyResize = () => {
      fitFrame = null;
      const forceResize = forceNextResize;
      forceNextResize = false;
      const previousCols = terminal.cols;
      const previousRows = terminal.rows;
      fitAddon.fit();
      if (showIosInputBridge) {
        terminal.scrollToBottom();
      }
      if (
        previousCols === terminal.cols &&
        previousRows === terminal.rows &&
        !forceResize
      ) {
        return;
      }
      if (!hasControlRef.current || !socketRef.current) {
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

    const scheduleFitAndResize = (options?: { force?: boolean }) => {
      if (options?.force) {
        forceNextResize = true;
      }
      if (fitFrame !== null) {
        window.cancelAnimationFrame(fitFrame);
      }
      fitFrame = window.requestAnimationFrame(fitAndNotifyResize);
    };
    scheduleTerminalFitRef.current = scheduleFitAndResize;
    scheduleFitAndResize();

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
        if (writeFrame !== null) {
          return;
        }
        writeFrame = window.requestAnimationFrame(() => {
          writeFrame = null;
          if (disposed || pendingWrite.length === 0) {
            return;
          }
          const chunk = pendingWrite.slice(0, MAX_TERMINAL_WRITE_BATCH_CHARS);
          pendingWrite = pendingWrite.slice(chunk.length);
          terminal.write(chunk);
          if (pendingWrite.length > 0) {
            scheduleTerminalWrite();
          }
        });
      };

      const enqueueTerminalWrite = (data: string) => {
        if (!data) {
          return;
        }
        pendingWrite += data;
        scheduleTerminalWrite();
      };

      const clearPendingTerminalWrite = () => {
        pendingWrite = "";
        if (writeFrame !== null) {
          window.cancelAnimationFrame(writeFrame);
          writeFrame = null;
        }
      };

      const socket = createPtySocket(
        props.terminalId,
        (message) => {
        if (message.type === "pty.replay") {
          if (fromSeq === undefined || message.droppedBeforeSeq !== undefined) {
            clearPendingTerminalWrite();
            terminal.reset();
          }
          enqueueTerminalWrite(message.chunks.join(""));
          if (message.nextSeq !== undefined) {
            nextReplaySeqRef.current = message.nextSeq;
          }
          return;
        }
        if (message.type === "pty.output") {
          enqueueTerminalWrite(message.data);
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
          enqueueTerminalWrite(
            `\r\n[session exited${message.exitCode !== undefined ? ` code=${message.exitCode}` : ""}]\r\n`,
          );
        }
      },
      (error) => {
        enqueueTerminalWrite(`\r\n[pty error] ${error.message}\r\n`);
      },
        fromSeq !== undefined ? { fromSeq } : undefined,
      );
      socketRef.current = socket;
      if (hasControlRef.current) {
        scheduleFitAndResize({ force: true });
      }
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
        reconnectTimer = setTimeout(() => {
          connect(nextReplaySeqRef.current);
        }, 1_000);
      });
    };

    connect();

    sendDataRef.current = (data: string, options?: { focusTerminal?: boolean }) => {
      if (!hasControlRef.current || !socketRef.current) {
        return;
      }
      sendPtyMessage(socketRef.current, {
        type: "pty.input",
        sessionId: props.terminalId,
        clientId: clientIdRef.current,
        data,
      });
      if (options?.focusTerminal !== false && !showIosInputBridge) {
        terminal.focus();
      }
    };

    const disposable = terminal.onData((data) => {
      if (!hasControlRef.current) {
        return;
      }
      sendDataRef.current(data);
    });

    const resizeObserver = new ResizeObserver(() => scheduleFitAndResize());
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      if (fitFrame !== null) {
        window.cancelAnimationFrame(fitFrame);
      }
      if (writeFrame !== null) {
        window.cancelAnimationFrame(writeFrame);
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      themeObserver.disconnect();
      resizeObserver.disconnect();
      disposable.dispose();
      socketRef.current?.close();
      terminal.dispose();
      socketRef.current = null;
      terminalRef.current = null;
      fitAddonRef.current = null;
      sendDataRef.current = () => undefined;
      scheduleTerminalFitRef.current = () => undefined;
    };
  }, [props.terminalId, showIosInputBridge]);

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

  const sendMobileShortcut = (shortcut: MobileTuiShortcut) => {
    sendDataRef.current(shortcut.data, { focusTerminal: false });
    if (shortcut.clearBridge) {
      committedBridgeValueRef.current = "";
      setBridgeValue("");
    }
    focusMobileBridge(mobileBridgeFocusOptionsForSource("shortcut"));
  };

  const keyboardActive = showIosInputBridge && keyboardInsetPx > 0;

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
        <div
          ref={containerRef}
          className="terminal-canvas"
          data-testid="terminal-canvas"
          onPointerDownCapture={
            showIosInputBridge
              ? (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  focusMobileBridge(mobileBridgeFocusOptionsForSource("surface"));
                }
              : undefined
          }
          onFocusCapture={
            showIosInputBridge
              ? (event) => {
                  const target = event.target;
                  if (
                    target instanceof HTMLTextAreaElement &&
                    target.classList.contains("xterm-helper-textarea")
                  ) {
                    event.stopPropagation();
                    focusMobileBridge(mobileBridgeFocusOptionsForSource("surface"));
                  }
                }
              : undefined
          }
        />
        {showIosInputBridge ? (
          <div className="terminal-ios-input-bridge" data-testid="terminal-ios-input-bridge">
            <div className="terminal-ios-shortcut-row" aria-label="TUI shortcut keys">
              {MOBILE_TUI_SHORTCUTS.map((shortcut) => (
                <button
                  key={shortcut.label}
                  type="button"
                  className="terminal-ios-shortcut"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => sendMobileShortcut(shortcut)}
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
