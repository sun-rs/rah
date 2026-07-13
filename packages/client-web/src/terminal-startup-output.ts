function stripTerminalControlText(data: string): string {
  return data
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\r/g, "\n")
    .trim();
}

export function isMeaningfulTerminalOutput(data: string): boolean {
  const text = stripTerminalControlText(data);
  if (!text) {
    return false;
  }
  return text.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !/^\[rah\]\s+Starting\b/.test(trimmed);
  });
}
