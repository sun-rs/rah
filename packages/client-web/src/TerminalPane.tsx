import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { createPtySocket, sendPtyMessage } from "./api";

interface TerminalPaneProps {
  sessionId: string;
  clientId: string;
  hasControl: boolean;
}

export function TerminalPane(props: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      theme: {
        background: "#08111f",
        foreground: "#d9e2f1",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const socket = createPtySocket(
      props.sessionId,
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

    const disposable = terminal.onData((data) => {
      if (!props.hasControl) {
        return;
      }
      sendPtyMessage(socket, {
        type: "pty.input",
        sessionId: props.sessionId,
        clientId: props.clientId,
        data,
      });
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (!props.hasControl) {
        return;
      }
      sendPtyMessage(socket, {
        type: "pty.resize",
        sessionId: props.sessionId,
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
    };
  }, [props.clientId, props.hasControl, props.sessionId]);

  return (
    <div className="terminal-panel">
      <div className="terminal-toolbar">
        <span>Shell terminal</span>
        <span className={props.hasControl ? "control-state control-on" : "control-state"}>
          {props.hasControl ? "interactive" : "observe"}
        </span>
      </div>
      <div ref={containerRef} className="terminal-canvas" />
    </div>
  );
}
