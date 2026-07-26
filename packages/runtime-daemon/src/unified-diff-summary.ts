import type { ConversationTurnFileChangesProjection } from "@rah/runtime-protocol";

type ParsedGitToken = {
  value: string;
  nextOffset: number;
};

type ParsedGitEscape = {
  bytes: Buffer;
  nextOffset: number;
};

export type ParsedUnifiedDiffFile = {
  path: string;
  diff: string;
  additions: number;
  deletions: number;
};

export type ParsedUnifiedDiff = {
  summary: ConversationTurnFileChangesProjection;
  files: ParsedUnifiedDiffFile[];
};

function decodeGitEscape(input: string, offset: number): ParsedGitEscape {
  const marker = input[offset];
  if (marker === undefined) {
    return { bytes: Buffer.from("\\"), nextOffset: offset };
  }
  const namedEscapes: Record<string, string> = {
    a: "\u0007",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\",
    '"': '"',
  };
  const named = namedEscapes[marker];
  if (named !== undefined) {
    return { bytes: Buffer.from(named), nextOffset: offset + 1 };
  }
  if (/[0-7]/.test(marker)) {
    const octal = input.slice(offset).match(/^[0-7]{1,3}/)?.[0] ?? marker;
    return {
      bytes: Buffer.from([Number.parseInt(octal, 8) & 0xff]),
      nextOffset: offset + octal.length,
    };
  }
  return { bytes: Buffer.from(marker), nextOffset: offset + 1 };
}

function parseGitToken(input: string, startOffset = 0): ParsedGitToken | null {
  let offset = startOffset;
  while (input[offset] === " " || input[offset] === "\t") {
    offset += 1;
  }
  if (offset >= input.length) {
    return null;
  }
  if (input[offset] !== '"') {
    const end = input.slice(offset).search(/[\t ]/);
    const nextOffset = end < 0 ? input.length : offset + end;
    return { value: input.slice(offset, nextOffset), nextOffset };
  }

  offset += 1;
  const chunks: Buffer[] = [];
  while (offset < input.length) {
    const codePoint = input.codePointAt(offset);
    if (codePoint === undefined) {
      break;
    }
    const character = String.fromCodePoint(codePoint);
    if (character === '"') {
      return { value: Buffer.concat(chunks).toString("utf8"), nextOffset: offset + 1 };
    }
    if (character === "\\") {
      const decoded = decodeGitEscape(input, offset + 1);
      chunks.push(decoded.bytes);
      offset = decoded.nextOffset;
      continue;
    }
    chunks.push(Buffer.from(character));
    offset += character.length;
  }
  return { value: Buffer.concat(chunks).toString("utf8"), nextOffset: offset };
}

function decodeWholeGitPath(raw: string): string {
  const value = raw.trim();
  if (!value.startsWith('"')) {
    return value.split("\t", 1)[0] ?? value;
  }
  return parseGitToken(value)?.value ?? value;
}

function stripGitSidePrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

function pathFromDiffHeader(header: string): { oldPath: string; newPath: string } | null {
  const first = parseGitToken(header);
  if (!first) {
    return null;
  }
  const second = parseGitToken(header, first.nextOffset);
  if (!second) {
    return null;
  }
  return {
    oldPath: stripGitSidePrefix(first.value),
    newPath: stripGitSidePrefix(second.value),
  };
}

function preferredFilePath(paths: {
  oldPath: string;
  newPath: string;
  renameFrom?: string;
  renameTo?: string;
  markerOldPath?: string;
  markerNewPath?: string;
}): string {
  const candidates = [
    paths.renameTo,
    paths.markerNewPath,
    paths.newPath,
    paths.renameFrom,
    paths.markerOldPath,
    paths.oldPath,
  ];
  return candidates.find((path) => path !== undefined && path !== "/dev/null") ?? paths.newPath;
}

/**
 * Parses the authoritative aggregate unified diff emitted by Codex for one
 * turn into its lightweight projection and frozen per-file diff fragments.
 * Every call returns a complete snapshot; callers must replace, not add to,
 * the previous artifact for the same turn.
 */
export function parseUnifiedDiff(diff: string): ParsedUnifiedDiff {
  const files = new Map<string, ParsedUnifiedDiffFile>();
  const sections = diff.split(/(?=^diff --git )/m);

  for (const section of sections) {
    const lines = section.split(/\r?\n/);
    const firstLine = lines[0];
    if (!firstLine?.startsWith("diff --git ")) {
      continue;
    }
    const headerPaths = pathFromDiffHeader(firstLine.slice("diff --git ".length));
    if (!headerPaths) {
      continue;
    }

    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    let markerOldPath: string | undefined;
    let markerNewPath: string | undefined;
    let additions = 0;
    let deletions = 0;
    let inHunk = false;

    for (const line of lines.slice(1)) {
      if (line.startsWith("rename from ")) {
        renameFrom = decodeWholeGitPath(line.slice("rename from ".length));
        continue;
      }
      if (line.startsWith("rename to ")) {
        renameTo = decodeWholeGitPath(line.slice("rename to ".length));
        continue;
      }
      if (line.startsWith("--- ")) {
        markerOldPath = stripGitSidePrefix(decodeWholeGitPath(line.slice(4)));
        inHunk = false;
        continue;
      }
      if (line.startsWith("+++ ")) {
        markerNewPath = stripGitSidePrefix(decodeWholeGitPath(line.slice(4)));
        inHunk = false;
        continue;
      }
      if (line.startsWith("@@")) {
        inHunk = true;
        continue;
      }
      if (!inHunk) {
        continue;
      }
      if (line.startsWith("+")) {
        additions += 1;
      } else if (line.startsWith("-")) {
        deletions += 1;
      }
    }

    const path = preferredFilePath({
      ...headerPaths,
      ...(renameFrom !== undefined ? { renameFrom } : {}),
      ...(renameTo !== undefined ? { renameTo } : {}),
      ...(markerOldPath !== undefined ? { markerOldPath } : {}),
      ...(markerNewPath !== undefined ? { markerNewPath } : {}),
    });
    const existing = files.get(path);
    if (existing) {
      existing.additions += additions;
      existing.deletions += deletions;
      existing.diff = `${existing.diff.trimEnd()}\n${section.trimEnd()}\n`;
    } else {
      files.set(path, {
        path,
        diff: `${section.trimEnd()}\n`,
        additions,
        deletions,
      });
    }
  }

  const parsedFiles = [...files.values()].sort((left, right) =>
    left.path === right.path ? 0 : left.path < right.path ? -1 : 1,
  );
  const projectedFiles = parsedFiles.map(({ path, additions, deletions }) => ({
    path,
    additions,
    deletions,
  }));
  return {
    summary: {
      files: projectedFiles,
      totalAdditions: projectedFiles.reduce((sum, file) => sum + file.additions, 0),
      totalDeletions: projectedFiles.reduce((sum, file) => sum + file.deletions, 0),
    },
    files: parsedFiles,
  };
}

export function summarizeUnifiedDiff(diff: string): ConversationTurnFileChangesProjection {
  return parseUnifiedDiff(diff).summary;
}
