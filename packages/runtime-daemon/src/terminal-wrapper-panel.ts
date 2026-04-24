import process from "node:process";

function charDisplayWidth(value: string): number {
  const codePoint = value.codePointAt(0);
  if (codePoint === undefined) {
    return 0;
  }
  if (
    codePoint >= 0x1100 &&
    (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    )
  ) {
    return 2;
  }
  return 1;
}

function stringDisplayWidth(value: string): number {
  return [...stripAnsi(value)].reduce((total, char) => total + charDisplayWidth(char), 0);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function truncateText(value: string, maxDisplayWidth: number): string {
  if (stringDisplayWidth(value) <= maxDisplayWidth) {
    return value;
  }
  const output: string[] = [];
  let width = 0;
  for (const char of value) {
    const nextWidth = width + charDisplayWidth(char);
    if (nextWidth > Math.max(0, maxDisplayWidth - 1)) {
      break;
    }
    output.push(char);
    width = nextWidth;
  }
  return `${output.join("").trimEnd()}…`;
}

function wrapText(value: string, width: number): string[] {
  if (width <= 0) {
    return [value];
  }
  const source = value.replace(/\s+/g, " ").trim();
  if (!source) {
    return [""];
  }
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const char of source) {
    if (!current && char === " ") {
      continue;
    }
    const charWidth = charDisplayWidth(char);
    if (currentWidth + charWidth <= width) {
      current += char;
      currentWidth += charWidth;
      continue;
    }
    lines.push(current.trimEnd());
    current = char === " " ? "" : char;
    currentWidth = char === " " ? 0 : charWidth;
  }
  if (current) {
    lines.push(current.trimEnd());
  }
  return lines.length > 0 ? lines : [source];
}

function padDisplayEnd(value: string, width: number): string {
  const remaining = Math.max(0, width - stringDisplayWidth(value));
  return `${value}${" ".repeat(remaining)}`;
}

function renderPanelLine(content: string, width: number): string {
  const padded = padDisplayEnd(content, width);
  return `│ ${padded} │`;
}

type PanelTone = "danger" | "success" | "warning";

function colorText(value: string, tone?: PanelTone): string {
  if (tone === "danger") {
    return `\u001b[31m${value}\u001b[0m`;
  }
  if (tone === "success") {
    return `\u001b[32m${value}\u001b[0m`;
  }
  if (tone === "warning") {
    return `\u001b[33m${value}\u001b[0m`;
  }
  return value;
}

export function clearTerminalScreen(): void {
  process.stdout.write("\u001b[2J\u001b[H");
}

export function enterAlternateScreen(): void {
  process.stdout.write("\u001b[?1049h");
}

export function leaveAlternateScreen(): void {
  process.stdout.write("\u001b[?1049l");
}

export function restoreInheritedTerminalModes(): void {
  process.stdout.write(
    "\u001b[<1u\u001b[?1004l\u001b[?2004l\u001b[?2026l\u001b[?25h\u001b[0m\r",
  );
}

export function renderTerminalWrapperPanel(args: {
  title: string;
  status: string;
  statusTone?: PanelTone;
  sessionId: string;
  prompt: string;
  footer: string;
  footerTone?: PanelTone;
}): string {
  const width = Math.min(Math.max((process.stdout.columns ?? 80) - 4, 36), 96);
  const allPromptLines = wrapText(args.prompt || "No active prompt.", width);
  const truncatedThirdLine = (() => {
    const thirdLine = allPromptLines[2] ?? "";
    const availableWidth = Math.max(1, width - 1);
    const truncated = truncateText(thirdLine, availableWidth);
    return truncated.endsWith("…") ? truncated : `${truncated}…`;
  })();
  const wrappedPrompt =
    allPromptLines.length <= 3
      ? allPromptLines
      : [
          allPromptLines[0] ?? "",
          allPromptLines[1] ?? "",
          truncatedThirdLine,
        ];
  return [
    "╭" + "─".repeat(width + 2) + "╮",
    renderPanelLine(args.title, width),
    renderPanelLine(colorText(`Status: ${args.status}`, args.statusTone), width),
    renderPanelLine(
      `Session: ${truncateText(args.sessionId, Math.max(12, width - 9))}`,
      width,
    ),
    renderPanelLine("", width),
    renderPanelLine("Current prompt:", width),
    ...wrappedPrompt.map((line) => renderPanelLine(line, width)),
    renderPanelLine("", width),
    renderPanelLine(colorText(args.footer, args.footerTone), width),
    "╰" + "─".repeat(width + 2) + "╯",
  ].join("\n");
}

export function renderTerminalWrapperPanelForTerminal(args: {
  title: string;
  status: string;
  statusTone?: PanelTone;
  sessionId: string;
  prompt: string;
  footer: string;
  footerTone?: PanelTone;
}): string {
  return renderTerminalWrapperPanel(args).replace(/\n/g, "\r\n");
}
