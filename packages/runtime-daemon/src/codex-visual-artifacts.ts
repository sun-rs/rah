import type {
  TimelineAssistantContentPart,
  TimelineVisualArtifact,
} from "@rah/runtime-protocol";

const INLINE_VISUAL_MARKER = "::codex-inline-vis";
const INLINE_VISUAL_DIRECTIVE =
  /^::codex-inline-vis\{file="([^"{}]+)"\}$/;
const SAFE_VISUAL_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/;

interface CodexInlineVisualDirective {
  start: number;
  end: number;
  fileName: string;
}

interface MarkdownFence {
  marker: "`" | "~";
  length: number;
}

export interface ParsedCodexAssistantContent {
  text: string;
  content?: TimelineAssistantContentPart[];
}

export function isSafeCodexVisualArtifactId(value: string): boolean {
  return SAFE_VISUAL_FILE_NAME.test(value);
}

function visualArtifact(fileName: string): TimelineVisualArtifact {
  return {
    id: fileName,
    format: "interactive_html",
    mimeType: "text/html",
    label: fileName.replace(/\.html$/i, "").replace(/[-_]+/g, " "),
  };
}

function pushTextPart(parts: TimelineAssistantContentPart[], value: string): void {
  const text = value.trim();
  if (text) {
    parts.push({ kind: "text", text });
  }
}

function openingFence(line: string): MarkdownFence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  const sequence = match?.[1];
  if (!sequence) {
    return undefined;
  }
  return {
    marker: sequence[0] as "`" | "~",
    length: sequence.length,
  };
}

function closesFence(line: string, fence: MarkdownFence): boolean {
  const trimmed = line.replace(/^ {0,3}/, "").trimEnd();
  if (
    trimmed.length < fence.length ||
    [...trimmed].some((character) => character !== fence.marker)
  ) {
    return false;
  }
  return true;
}

function scanCodexInlineVisualDirectives(value: string): {
  directives: CodexInlineVisualDirective[];
  trailingLineStart: number;
  trailingLineInsideFence: boolean;
} {
  const directives: CodexInlineVisualDirective[] = [];
  let fence: MarkdownFence | undefined;
  let cursor = 0;
  let trailingLineStart = 0;
  let trailingLineInsideFence = false;

  while (cursor <= value.length) {
    const newline = value.indexOf("\n", cursor);
    const lineEnd = newline >= 0 ? newline : value.length;
    const rawLine = value.slice(cursor, lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const lineInsideFence = fence !== undefined;

    if (fence) {
      if (closesFence(line, fence)) {
        fence = undefined;
      }
    } else {
      const nextFence = openingFence(line);
      if (nextFence) {
        fence = nextFence;
      } else {
        const directive = INLINE_VISUAL_DIRECTIVE.exec(line);
        const fileName = directive?.[1];
        if (fileName && isSafeCodexVisualArtifactId(fileName)) {
          directives.push({
            start: cursor,
            end: lineEnd,
            fileName,
          });
        }
      }
    }

    trailingLineStart = cursor;
    trailingLineInsideFence = lineInsideFence;
    if (newline < 0) {
      break;
    }
    cursor = newline + 1;
  }

  return {
    directives,
    trailingLineStart,
    trailingLineInsideFence,
  };
}

/**
 * Converts Codex's persisted inline-visual directive into ordered canonical
 * assistant content. Only the exact provider directive, on its own Markdown
 * line and outside a fenced code block, is interpreted. Examples, unknown
 * syntax, and malformed directives remain ordinary text.
 *
 * During streaming, an incomplete directive tail is withheld so raw protocol
 * syntax never flashes in the chat before the completed item arrives.
 */
export function parseCodexAssistantContent(
  value: string,
  options: { streaming?: boolean } = {},
): ParsedCodexAssistantContent {
  const parts: TimelineAssistantContentPart[] = [];
  const scan = scanCodexInlineVisualDirectives(value);
  let cursor = 0;

  for (const directive of scan.directives) {
    pushTextPart(parts, value.slice(cursor, directive.start));
    parts.push({
      kind: "visual",
      artifact: visualArtifact(directive.fileName),
    });
    cursor = directive.end;
  }

  let tail = value.slice(cursor);
  const trailingLine = value.slice(scan.trailingLineStart).replace(/\r$/, "");
  const incompleteDirectiveStart =
    options.streaming &&
    !scan.trailingLineInsideFence &&
    trailingLine.startsWith(INLINE_VISUAL_MARKER) &&
    !trailingLine.endsWith("}")
      ? scan.trailingLineStart
      : undefined;
  if (
    incompleteDirectiveStart !== undefined &&
    incompleteDirectiveStart >= cursor
  ) {
    tail = value.slice(cursor, incompleteDirectiveStart);
  }
  pushTextPart(parts, tail);

  const text = parts
    .filter((part): part is Extract<TimelineAssistantContentPart, { kind: "text" }> =>
      part.kind === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim();

  return scan.directives.length > 0
    ? { text, content: parts }
    : {
        text:
          incompleteDirectiveStart !== undefined
            ? value.slice(0, incompleteDirectiveStart).trim()
            : value.trim(),
      };
}

export function codexAssistantContentSignature(
  parsed: ParsedCodexAssistantContent,
): string {
  if (!parsed.content) {
    return parsed.text;
  }
  return parsed.content
    .map((part) =>
      part.kind === "text"
        ? `text:${part.text}`
        : `visual:${part.artifact.format}:${part.artifact.id}`)
    .join("\u001f");
}
