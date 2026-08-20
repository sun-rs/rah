import type {
  TimelineAssistantContentPart,
  TimelineVisualArtifact,
} from "@rah/runtime-protocol";
import path from "node:path";

const INLINE_VISUAL_MARKER = "::codex-inline-vis";
const INLINE_VISUAL_DIRECTIVE =
  /^::codex-inline-vis\{file="([^"{}]+)"\}$/;
const LEGACY_VISUAL_MARKER = "visualize";
const LEGACY_VISUAL_SUFFIX = "";
const SAFE_VISUAL_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/;
const PATH_ARTIFACT_PREFIX = "path~";
const VISUAL_PATH_EVIDENCE = /(?:\/|\.codex\/)[^\\\s\"'`<>]+\.html\b/g;

interface CodexInlineVisualDirective {
  start: number;
  end: number;
  artifactId: string;
  label: string;
}

interface MarkdownFence {
  marker: "`" | "~";
  length: number;
}

export interface ParsedCodexAssistantContent {
  text: string;
  content?: TimelineAssistantContentPart[];
}

export interface CodexVisualArtifactPathEvidenceState {
  visualArtifactPathByFileName: Map<string, string>;
}

export function isSafeCodexVisualArtifactId(value: string): boolean {
  return (
    SAFE_VISUAL_FILE_NAME.test(value) ||
    (value.startsWith(PATH_ARTIFACT_PREFIX) &&
      codexVisualArtifactPathFromId(value) !== undefined)
  );
}

export function codexVisualArtifactIdForPath(value: string): string | undefined {
  const normalized = value.trim();
  const fileName = path.posix.basename(normalized.replaceAll("\\", "/"));
  if (
    !SAFE_VISUAL_FILE_NAME.test(fileName) ||
    !normalized.replaceAll("\\", "/").includes(".codex/visualizations/")
  ) {
    return undefined;
  }
  return `${PATH_ARTIFACT_PREFIX}${Buffer.from(normalized, "utf8").toString("base64url")}`;
}

export function codexVisualArtifactPathFromId(value: string): string | undefined {
  if (!value.startsWith(PATH_ARTIFACT_PREFIX)) {
    return undefined;
  }
  const encoded = value.slice(PATH_ARTIFACT_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    return codexVisualArtifactIdForPath(decoded) === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function collectCodexVisualArtifactPathEvidence(
  value: unknown,
  pathsByFileName: Map<string, string>,
): void {
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return;
  }
  for (const match of serialized.matchAll(VISUAL_PATH_EVIDENCE)) {
    const candidate = match[0]?.replaceAll("\\/", "/");
    if (!candidate || !codexVisualArtifactIdForPath(candidate)) {
      continue;
    }
    pathsByFileName.set(path.posix.basename(candidate), candidate);
  }
}

export function observeCodexVisualArtifactPathEvidence(
  value: unknown,
  state: CodexVisualArtifactPathEvidenceState,
): void {
  collectCodexVisualArtifactPathEvidence(value, state.visualArtifactPathByFileName);
}

function visualArtifact(artifactId: string, label: string): TimelineVisualArtifact {
  return {
    id: artifactId,
    format: "interactive_html",
    mimeType: "text/html",
    label: label.replace(/\.html$/i, "").replace(/[-_]+/g, " "),
  };
}

function parseVisualDirective(
  line: string,
  resolveVisualArtifactId?: (fileName: string) => string | undefined,
): { artifactId: string; label: string } | undefined {
  const inline = INLINE_VISUAL_DIRECTIVE.exec(line);
  const fileName = inline?.[1];
  if (fileName && isSafeCodexVisualArtifactId(fileName)) {
    return {
      artifactId: resolveVisualArtifactId?.(fileName) ?? fileName,
      label: fileName,
    };
  }
  if (!line.startsWith(LEGACY_VISUAL_MARKER) || !line.endsWith(LEGACY_VISUAL_SUFFIX)) {
    return undefined;
  }
  try {
    const payload = JSON.parse(
      line.slice(LEGACY_VISUAL_MARKER.length, -LEGACY_VISUAL_SUFFIX.length),
    ) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return undefined;
    }
    const visualPath = (payload as Record<string, unknown>).path;
    if (typeof visualPath !== "string") {
      return undefined;
    }
    const artifactId = codexVisualArtifactIdForPath(visualPath);
    if (!artifactId) {
      return undefined;
    }
    return {
      artifactId,
      label: path.posix.basename(visualPath.replaceAll("\\", "/")),
    };
  } catch {
    return undefined;
  }
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

function scanCodexInlineVisualDirectives(
  value: string,
  resolveVisualArtifactId?: (fileName: string) => string | undefined,
): {
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
        const directive = parseVisualDirective(line, resolveVisualArtifactId);
        if (directive) {
          directives.push({
            start: cursor,
            end: lineEnd,
            ...directive,
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
  options: {
    streaming?: boolean;
    resolveVisualArtifactId?: (fileName: string) => string | undefined;
  } = {},
): ParsedCodexAssistantContent {
  const parts: TimelineAssistantContentPart[] = [];
  const scan = scanCodexInlineVisualDirectives(
    value,
    options.resolveVisualArtifactId,
  );
  let cursor = 0;

  for (const directive of scan.directives) {
    pushTextPart(parts, value.slice(cursor, directive.start));
    parts.push({
      kind: "visual",
      artifact: visualArtifact(directive.artifactId, directive.label),
    });
    cursor = directive.end;
  }

  let tail = value.slice(cursor);
  const trailingLine = value.slice(scan.trailingLineStart).replace(/\r$/, "");
  const incompleteDirectiveStart =
    options.streaming &&
    !scan.trailingLineInsideFence &&
    ((trailingLine.startsWith(INLINE_VISUAL_MARKER) &&
      !trailingLine.endsWith("}")) ||
      (trailingLine.startsWith(LEGACY_VISUAL_MARKER) &&
        !trailingLine.endsWith(LEGACY_VISUAL_SUFFIX)))
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

export function parseCodexAssistantContentWithVisualEvidence(
  value: string,
  state: CodexVisualArtifactPathEvidenceState,
  options: { streaming?: boolean } = {},
): ParsedCodexAssistantContent {
  return parseCodexAssistantContent(value, {
    ...options,
    resolveVisualArtifactId: (fileName) => {
      const evidencedPath = state.visualArtifactPathByFileName.get(fileName);
      return evidencedPath
        ? codexVisualArtifactIdForPath(evidencedPath)
        : undefined;
    },
  });
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
