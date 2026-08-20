import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export type TextLineAtOffset = {
  text: string;
  startOffset: number;
  endOffset: number;
};

type TrailingBufferWindow = {
  buffer: Buffer;
  bufferStartOffset: number;
  contentStart: number;
  startOffset: number;
  endOffset: number;
  bytesRead: number;
};

function readTrailingBufferWindow(
  filePath: string,
  options: { endOffset?: number; maxLines: number; chunkBytes?: number },
): TrailingBufferWindow {
  const fd = openSync(filePath, "r");
  try {
    const fileSize = fstatSync(fd).size;
    const endOffset = Math.max(0, Math.min(options.endOffset ?? fileSize, fileSize));
    const chunkBytes = Math.max(1024, options.chunkBytes ?? 64 * 1024);
    const requiredNewlines = options.maxLines + (endOffset < fileSize ? 1 : 0);

    let position = endOffset;
    let newlineCount = 0;
    let bytesReadTotal = 0;
    const chunks: Buffer[] = [];

    while (position > 0 && newlineCount < requiredNewlines) {
      const chunkStart = Math.max(0, position - chunkBytes);
      const bytesToRead = position - chunkStart;
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, chunkStart);
      const chunk = buffer.subarray(0, bytesRead);
      bytesReadTotal += bytesRead;
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
    let contentStart = 0;
    if (position > 0) {
      const firstNewlineIndex = combined.indexOf(0x0a);
      if (firstNewlineIndex === -1) {
        return {
          buffer: Buffer.alloc(0),
          bufferStartOffset: endOffset,
          contentStart: 0,
          startOffset: endOffset,
          endOffset,
          bytesRead: bytesReadTotal,
        };
      }
      contentStart = firstNewlineIndex + 1;
      startOffset = position + contentStart;
    }

    return {
      buffer: combined,
      bufferStartOffset: position,
      contentStart,
      startOffset,
      endOffset,
      bytesRead: bytesReadTotal,
    };
  } finally {
    closeSync(fd);
  }
}

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
  const window = readTrailingBufferWindow(filePath, options);
  const text = window.buffer.subarray(window.contentStart).toString("utf8");
  return {
    lines: text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    startOffset: window.startOffset,
    endOffset: window.endOffset,
  };
}

/**
 * Reads a complete trailing line window while retaining byte boundaries.
 * Offset-aware consumers can turn a semantic record boundary into a stable,
 * stateless pagination cursor instead of retaining hidden in-memory carry.
 */
export function readTrailingLineRecordsWindow(
  filePath: string,
  options: { endOffset?: number; maxLines: number; chunkBytes?: number },
): {
  lines: TextLineAtOffset[];
  startOffset: number;
  endOffset: number;
  bytesRead: number;
} {
  const window = readTrailingBufferWindow(filePath, options);
  const lines: TextLineAtOffset[] = [];
  let lineStart = window.contentStart;
  while (lineStart < window.buffer.length) {
    const newlineIndex = window.buffer.indexOf(0x0a, lineStart);
    const contentEnd = newlineIndex >= 0 ? newlineIndex : window.buffer.length;
    const raw = window.buffer.subarray(lineStart, contentEnd);
    const text = raw.toString("utf8").replace(/\r$/, "").trim();
    if (text) {
      lines.push({
        text,
        startOffset: window.bufferStartOffset + lineStart,
        endOffset:
          window.bufferStartOffset +
          (newlineIndex >= 0 ? newlineIndex + 1 : contentEnd),
      });
    }
    if (newlineIndex < 0) {
      break;
    }
    lineStart = newlineIndex + 1;
  }
  return {
    lines,
    startOffset: window.startOffset,
    endOffset: window.endOffset,
    bytesRead: window.bytesRead,
  };
}

export function readTextRange(
  filePath: string,
  options: { startOffset: number; endOffset?: number },
): string {
  const fd = openSync(filePath, "r");
  try {
    const fileSize = fstatSync(fd).size;
    const startOffset = Math.max(0, Math.min(options.startOffset, fileSize));
    const endOffset = Math.max(startOffset, Math.min(options.endOffset ?? fileSize, fileSize));
    const length = endOffset - startOffset;
    if (length === 0) {
      return "";
    }
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, startOffset);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
