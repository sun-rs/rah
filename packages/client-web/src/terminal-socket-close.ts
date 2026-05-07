export function ptySocketCloseNotice(code: number, reason: string): string | null {
  if (code !== 1013) {
    return null;
  }
  const detail = reason.trim() || "PTY client is too slow";
  return `[pty disconnected] ${detail}; reconnecting from replay.`;
}
