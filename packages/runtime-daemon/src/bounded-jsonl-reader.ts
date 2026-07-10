import { createReadStream } from "node:fs";

const DEFAULT_HEAD_BYTES = 1_024;
const DEFAULT_MAX_SELECTED_LINE_BYTES = 2 * 1024 * 1024;

export type SelectedJsonlLine = {
  text: string;
  startOffset: number;
  endOffset: number;
};

export async function scanSelectedJsonlLines(args: {
  filePath: string;
  startOffset?: number;
  endOffset?: number;
  selectHead: (head: string) => boolean;
  onLine: (line: SelectedJsonlLine) => void;
  onOversizedSelectedLine?: (head: string, context: Omit<SelectedJsonlLine, "text">) => void;
  headBytes?: number;
  maxSelectedLineBytes?: number;
}): Promise<number> {
  const startOffset = args.startOffset ?? 0;
  if (args.endOffset !== undefined && args.endOffset <= startOffset) {
    return startOffset;
  }
  const headLimit = args.headBytes ?? DEFAULT_HEAD_BYTES;
  const selectedLineLimit = args.maxSelectedLineBytes ?? DEFAULT_MAX_SELECTED_LINE_BYTES;
  const stream = createReadStream(args.filePath, {
    start: startOffset,
    ...(args.endOffset !== undefined ? { end: args.endOffset - 1 } : {}),
  });

  let streamOffset = startOffset;
  let lineStartOffset = startOffset;
  let scannedBytes = startOffset;
  let headChunks: Buffer[] = [];
  let headLength = 0;
  let retainedChunks: Buffer[] = [];
  let retainedLength = 0;
  let selected: boolean | null = null;
  let oversized = false;

  const headText = () => Buffer.concat(headChunks, headLength).toString("utf8");
  const resetLine = (nextOffset: number) => {
    lineStartOffset = nextOffset;
    headChunks = [];
    headLength = 0;
    retainedChunks = [];
    retainedLength = 0;
    selected = null;
    oversized = false;
  };
  const appendSegment = (segment: Buffer) => {
    if (segment.length === 0) {
      return;
    }
    if (headLength < headLimit) {
      const headPart = segment.subarray(0, headLimit - headLength);
      headChunks.push(headPart);
      headLength += headPart.length;
    }
    if (selected === null && headLength >= headLimit) {
      selected = args.selectHead(headText());
      if (!selected) {
        retainedChunks = [];
        retainedLength = 0;
      }
    }
    if (selected === false || oversized) {
      return;
    }
    if (retainedLength + segment.length > selectedLineLimit) {
      oversized = true;
      retainedChunks = [];
      retainedLength = 0;
      return;
    }
    retainedChunks.push(segment);
    retainedLength += segment.length;
  };
  const finishLine = (endOffset: number) => {
    if (selected === null) {
      selected = args.selectHead(headText());
    }
    if (selected) {
      if (oversized) {
        args.onOversizedSelectedLine?.(headText(), {
          startOffset: lineStartOffset,
          endOffset,
        });
      } else {
        const bytes = Buffer.concat(retainedChunks, retainedLength);
        const content = bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
        args.onLine({
          text: content.toString("utf8"),
          startOffset: lineStartOffset,
          endOffset,
        });
      }
    }
    scannedBytes = endOffset;
    resetLine(endOffset);
  };

  for await (const chunkValue of stream) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    let cursor = 0;
    for (;;) {
      const newlineIndex = chunk.indexOf(0x0a, cursor);
      if (newlineIndex < 0) {
        appendSegment(chunk.subarray(cursor));
        break;
      }
      appendSegment(chunk.subarray(cursor, newlineIndex));
      finishLine(streamOffset + newlineIndex + 1);
      cursor = newlineIndex + 1;
    }
    streamOffset += chunk.length;
  }
  return scannedBytes;
}
