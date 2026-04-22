import { closeSync, fstatSync, openSync, readSync } from "node:fs";

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

export function readTrailingLinesWindow(
  filePath: string,
  options: { endOffset?: number; maxLines: number; chunkBytes?: number },
): { lines: string[]; startOffset: number; endOffset: number } {
  const fd = openSync(filePath, "r");
  try {
    const fileSize = fstatSync(fd).size;
    const endOffset = Math.max(0, Math.min(options.endOffset ?? fileSize, fileSize));
    const chunkBytes = Math.max(1024, options.chunkBytes ?? 64 * 1024);
    const requiredNewlines = options.maxLines + (endOffset < fileSize ? 1 : 0);

    let position = endOffset;
    let newlineCount = 0;
    const chunks: Buffer[] = [];

    while (position > 0 && newlineCount < requiredNewlines) {
      const chunkStart = Math.max(0, position - chunkBytes);
      const bytesToRead = position - chunkStart;
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, chunkStart);
      const chunk = buffer.subarray(0, bytesRead);
      for (const byte of chunk) {
        if (byte === 0x0a) {
          newlineCount += 1;
        }
      }
      chunks.unshift(chunk);
      position = chunkStart;
    }

    const combined = Buffer.concat(chunks);
    let startOffset = position;
    let sliceStart = 0;
    if (position > 0) {
      const firstNewlineIndex = combined.indexOf(0x0a);
      if (firstNewlineIndex === -1) {
        return { lines: [], startOffset: endOffset, endOffset };
      }
      sliceStart = firstNewlineIndex + 1;
      startOffset = position + sliceStart;
    }

    const text = combined.subarray(sliceStart).toString("utf8");
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    return {
      lines,
      startOffset,
      endOffset,
    };
  } finally {
    closeSync(fd);
  }
}
