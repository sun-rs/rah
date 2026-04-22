import { openSync, readSync, closeSync } from "node:fs";

export function readLeadingText(filePath: string, maxBytes: number): string {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function readLeadingLines(
  filePath: string,
  options: { maxBytes: number; maxLines?: number },
): string[] {
  const content = readLeadingText(filePath, options.maxBytes);
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(0, options.maxLines ?? lines.length);
}
