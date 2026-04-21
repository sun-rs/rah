import React, { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export function TerminalPane({ content }: { content: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      theme: {
        background: "#09090b", // zinc-950
        foreground: "#d4d4d8", // zinc-300
      },
      convertEol: true,
      rows: 15,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Write initial content
    term.write(content);

    const handleResize = () => fitAddon.fit();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      term.dispose();
    };
  }, []);

  useEffect(() => {
    // When content updates, we append only new data if we were tracking seq,
    // but here we have the full content string for simplicity.
    // In a real PTY we'd only write the delta.
    if (termRef.current) {
      termRef.current.clear();
      termRef.current.write(content);
    }
  }, [content]);

  return (
    <div className="bg-zinc-950 rounded-xl border border-zinc-800 overflow-hidden shadow-2xl">
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-900 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-red-500/50"></div>
            <div className="w-2.5 h-2.5 rounded-full bg-amber-500/50"></div>
            <div className="w-2.5 h-2.5 rounded-full bg-green-500/50"></div>
          </div>
          <span className="text-[10px] font-mono text-zinc-500 ml-2">PTY Intercepted</span>
        </div>
      </div>
      <div ref={containerRef} className="p-2 h-[300px]" />
    </div>
  );
}
