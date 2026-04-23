import type { ObservationKind, ToolFamily } from "@rah/runtime-protocol";

export interface CodexCommandClassification {
  kind: ObservationKind;
  title: string;
  family: ToolFamily;
  files?: string[];
  query?: string;
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function extractReadFiles(command: string): string[] {
  return unique(
    [...command.matchAll(/(?:^|\s)(?:cat|less|head|tail|sed|nl)\s+(?:-[^\s]+\s+)*(?<path>[^\s|;&]+)/g)]
      .map((match) => match.groups?.path)
      .filter((value): value is string => Boolean(value))
      .map(stripQuotes)
      .filter((value) => !value.startsWith("-")),
  );
}

function extractListFiles(command: string): string[] {
  return unique(
    [...command.matchAll(/(?:^|\s)(?:ls|tree)\s+(?:-[^\s]+\s+)*(?<path>[^\s|;&]+)/g)]
      .map((match) => match.groups?.path)
      .filter((value): value is string => Boolean(value))
      .map(stripQuotes)
      .filter((value) => !value.startsWith("-")),
  );
}

function extractSearchQuery(command: string): string | undefined {
  const match = /(?:rg|grep)\s+(?:-[^\s]+\s+)*(?:"([^"]+)"|'([^']+)'|([^\s|;&]+))/.exec(command);
  return match ? match[1] ?? match[2] ?? match[3] : undefined;
}

function extractPatchFiles(command: string): string[] {
  const refs = new Set<string>();
  for (const line of command.split(/\r?\n/)) {
    const match =
      /^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/.exec(line) ??
      /^\*\*\* Move to:\s+(.+)$/.exec(line);
    if (match?.[1]) {
      refs.add(match[1].trim());
    }
  }
  return [...refs];
}

export function classifyCodexCommand(command: string): CodexCommandClassification {
  const trimmed = command.trim();
  if (/^\s*(?:apply_patch|python\s+-m\s+apply_patch)\b/.test(trimmed) || trimmed.includes("*** Begin Patch")) {
    const files = extractPatchFiles(trimmed);
    return {
      kind: "patch.apply",
      title: "Apply patch",
      family: "patch",
      ...(files.length > 0 ? { files } : {}),
    };
  }

  const readFiles = extractReadFiles(trimmed);
  if (readFiles.length > 0) {
    return {
      kind: "file.read",
      title: `Read ${readFiles[0]}`,
      family: "file_read",
      files: readFiles,
    };
  }

  if (/^\s*(?:ls|tree)\b/.test(trimmed)) {
    const files = extractListFiles(trimmed);
    return {
      kind: "file.list",
      title: "List files",
      family: "search",
      ...(files.length > 0 ? { files } : {}),
    };
  }

  if (/^\s*(?:rg|grep|fd|find)\b/.test(trimmed)) {
    const query = extractSearchQuery(trimmed);
    return {
      kind: "file.search",
      title: "Search workspace",
      family: "search",
      ...(query !== undefined ? { query } : {}),
    };
  }

  if (/\b(?:cargo|npm|pnpm|yarn|pytest|go|uv)\s+(?:test|nextest)\b|\bpytest\b|\bgo\s+test\b/.test(trimmed)) {
    return {
      kind: "test.run",
      title: "Run tests",
      family: "test",
    };
  }

  if (
    /\b(?:cargo|npm|pnpm|yarn|go)\s+(?:build|check)\b/.test(trimmed) ||
    /\b(?:npm|pnpm|yarn)\s+run\s+build\b/.test(trimmed) ||
    /\b(?:tsc|vite|next)\s+(?:--noEmit|build)\b/.test(trimmed)
  ) {
    return {
      kind: "build.run",
      title: "Run build/check",
      family: "build",
    };
  }

  if (/\b(?:cargo\s+clippy|eslint|ruff|biome|prettier|just\s+fix)\b/.test(trimmed)) {
    return {
      kind: "lint.run",
      title: "Run lint/fix",
      family: "lint",
    };
  }

  if (/^\s*git\s+status\b/.test(trimmed)) {
    return { kind: "git.status", title: "Inspect git status", family: "git" };
  }
  if (/^\s*git\s+diff\b/.test(trimmed)) {
    return { kind: "git.diff", title: "Inspect git diff", family: "git" };
  }
  if (/^\s*git\s+apply\b/.test(trimmed)) {
    return { kind: "git.apply", title: "Apply git patch", family: "git" };
  }

  return {
    kind: "command.run",
    title: "Run command",
    family: "shell",
  };
}
