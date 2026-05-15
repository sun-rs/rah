export type TerminalShortcut = {
  label: string;
  data: string;
  clearBridge?: boolean;
  ariaLabel?: string;
};

export const TERMINAL_TUI_SHORTCUTS: readonly TerminalShortcut[] = [
  { label: "Esc", data: "\u001b", clearBridge: true },
  { label: "Ctrl-C", data: "\u0003", clearBridge: true },
  { label: "Ctrl-D", data: "\u0004", clearBridge: true },
  { label: "Ctrl-Z", data: "\u001a", clearBridge: true },
  { label: "Tab", data: "\t" },
  { label: "↑", data: "\u001b[A", ariaLabel: "Arrow up" },
  { label: "↓", data: "\u001b[B", ariaLabel: "Arrow down" },
  { label: "←", data: "\u001b[D", ariaLabel: "Arrow left" },
  { label: "→", data: "\u001b[C", ariaLabel: "Arrow right" },
  { label: "Enter", data: "\r", clearBridge: true },
];
