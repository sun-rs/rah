import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { createPtySocket, sendPtyMessage } from "./api";

interface TerminalPaneProps {
  terminalId: string;
  clientId: string;
  hasControl: boolean;
}

function shouldShowMobileInputBridge(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") {
    return false;
  }
  const userAgent = navigator.userAgent || "";
  const iosLike =
    /iPad|iPhone|iPod/.test(userAgent) ||
    (/Macintosh/.test(userAgent) && navigator.maxTouchPoints > 1);
  const touchSmallScreen =
    navigator.maxTouchPoints > 0 && window.matchMedia("(max-width: 768px)").matches;
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

export function TerminalPane(props: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sendDataRef = useRef<(data: string, options?: { focusTerminal?: boolean }) => void>(() => undefined);
  const [showIosInputBridge, setShowIosInputBridge] = useState(false);
  const [bridgeValue, setBridgeValue] = useState("");
  const committedBridgeValueRef = useRef("");
  const bridgeInputRef = useRef<HTMLInputElement | null>(null);
  const isComposingRef = useRef(false);

  useEffect(() => {
    setShowIosInputBridge(shouldShowMobileInputBridge());
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: showIosInputBridge ? 11 : 13,
      theme: {
        background: "#08111f",
        foreground: "#d9e2f1",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();
    terminal.focus();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const socket = createPtySocket(
      props.terminalId,
      (message) => {
        if (message.type === "pty.replay") {
          terminal.reset();
          for (const chunk of message.chunks) {
            terminal.write(chunk);
          }
          return;
        }
        if (message.type === "pty.output") {
          terminal.write(message.data);
          return;
        }
        if (message.type === "pty.exited") {
          terminal.writeln("");
          terminal.writeln(
            `[session exited${message.exitCode !== undefined ? ` code=${message.exitCode}` : ""}]`,
          );
        }
      },
      (error) => {
        terminal.writeln(`\r\n[pty error] ${error.message}`);
      },
    );

    sendDataRef.current = (data: string, options?: { focusTerminal?: boolean }) => {
      if (!props.hasControl) {
        return;
      }
      sendPtyMessage(socket, {
        type: "pty.input",
        sessionId: props.terminalId,
        clientId: props.clientId,
        data,
      });
      if (options?.focusTerminal !== false) {
        terminal.focus();
      }
    };

    const disposable = terminal.onData((data) => {
      if (!props.hasControl) {
        return;
      }
      sendDataRef.current(data);
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (!props.hasControl) {
        return;
      }
      sendPtyMessage(socket, {
        type: "pty.resize",
        sessionId: props.terminalId,
        clientId: props.clientId,
        cols: terminal.cols,
        rows: terminal.rows,
      });
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      disposable.dispose();
      socket.close();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      sendDataRef.current = () => undefined;
    };
  }, [props.clientId, props.hasControl, props.terminalId, showIosInputBridge]);

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

  const commitBridgeInsertion = (text: string) => {
    if (!text) {
      return;
    }
    sendDataRef.current(text, { focusTerminal: false });
    const nextValue = `${committedBridgeValueRef.current}${text}`;
    committedBridgeValueRef.current = nextValue;
    setBridgeValue(nextValue);
  };

  const commitBridgeBackspace = () => {
    if (committedBridgeValueRef.current.length === 0) {
      sendDataRef.current("\u007f", { focusTerminal: false });
      return;
    }
    sendDataRef.current("\u007f", { focusTerminal: false });
    const nextValue = committedBridgeValueRef.current.slice(0, -1);
    committedBridgeValueRef.current = nextValue;
    setBridgeValue(nextValue);
  };

  return (
    <div className="terminal-panel" data-testid="terminal-panel">
      {showIosInputBridge ? (
        <div className="terminal-ios-input-bridge" data-testid="terminal-ios-input-bridge">
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
      <div ref={containerRef} className="terminal-canvas" data-testid="terminal-canvas" />
    </div>
  );
}
