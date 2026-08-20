import path from "node:path";
import {
  codexStoredSessionWorkspaceRoot,
  type CodexStoredSessionRecord,
} from "./codex-stored-session-types";
import {
  codexVisualArtifactPathFromId,
  isSafeCodexVisualArtifactId,
} from "./codex-visual-artifacts";

export interface CodexVisualArtifactCandidate {
  artifactPath: string;
  securityRootPath: string;
}

function storageHome(rolloutPath: string): string | undefined {
  let cursor = path.resolve(path.dirname(rolloutPath));
  while (true) {
    const name = path.basename(cursor);
    if (name === "sessions" || name === "archived_sessions") {
      return path.dirname(cursor);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return undefined;
    }
    cursor = parent;
  }
}

function rolloutDate(record: CodexStoredSessionRecord): [string, string, string] | undefined {
  const activePath = record.rolloutPath
    .split(path.sep)
    .filter(Boolean);
  const sessionsIndex = activePath.lastIndexOf("sessions");
  if (
    sessionsIndex >= 0 &&
    /^\d{4}$/.test(activePath[sessionsIndex + 1] ?? "") &&
    /^\d{2}$/.test(activePath[sessionsIndex + 2] ?? "") &&
    /^\d{2}$/.test(activePath[sessionsIndex + 3] ?? "")
  ) {
    return [
      activePath[sessionsIndex + 1]!,
      activePath[sessionsIndex + 2]!,
      activePath[sessionsIndex + 3]!,
    ];
  }
  const fileDate = /rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(
    path.basename(record.rolloutPath),
  );
  if (fileDate) {
    return [fileDate[1]!, fileDate[2]!, fileDate[3]!];
  }
  if (!record.ref.createdAt) {
    return undefined;
  }
  const createdAt = new Date(record.ref.createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    return undefined;
  }
  return [
    String(createdAt.getUTCFullYear()).padStart(4, "0"),
    String(createdAt.getUTCMonth() + 1).padStart(2, "0"),
    String(createdAt.getUTCDate()).padStart(2, "0"),
  ];
}

export function resolveCodexVisualArtifactRoot(
  record: CodexStoredSessionRecord,
): string | undefined {
  const home = storageHome(record.rolloutPath);
  return home ? path.join(home, "visualizations") : undefined;
}

export function resolveCodexVisualArtifactPath(
  record: CodexStoredSessionRecord,
  artifactId: string,
): string | undefined {
  if (
    !isSafeCodexVisualArtifactId(artifactId) ||
    !/^[A-Za-z0-9-]+$/.test(record.ref.providerSessionId)
  ) {
    return undefined;
  }
  const root = resolveCodexVisualArtifactRoot(record);
  const date = rolloutDate(record);
  if (!root || !date) {
    return undefined;
  }
  return path.join(
    root,
    ...date,
    record.ref.providerSessionId,
    artifactId,
  );
}

/**
 * Codex can materialize an inline visualization beside the active workspace
 * (the current Visualize skill contract) or in its provider-owned storage
 * home (older desktop builds). Keep both locations readable without ever
 * searching outside the exact date/session/file tuple carried by history.
 */
export function resolveCodexVisualArtifactCandidates(
  record: CodexStoredSessionRecord,
  artifactId: string,
): CodexVisualArtifactCandidate[] {
  if (
    !isSafeCodexVisualArtifactId(artifactId) ||
    !/^[A-Za-z0-9-]+$/.test(record.ref.providerSessionId)
  ) {
    return [];
  }
  const evidencedPath = codexVisualArtifactPathFromId(artifactId);
  if (evidencedPath) {
    const candidates: CodexVisualArtifactCandidate[] = [];
    const workspaceRoot = codexStoredSessionWorkspaceRoot(record);
    const storageRoot = resolveCodexVisualArtifactRoot(record);
    const resolvedPath = path.isAbsolute(evidencedPath)
      ? path.resolve(evidencedPath)
      : workspaceRoot
        ? path.resolve(workspaceRoot, evidencedPath)
        : undefined;
    for (const securityRootPath of [
      workspaceRoot
        ? path.join(path.resolve(workspaceRoot), ".codex", "visualizations")
        : undefined,
      storageRoot,
    ]) {
      if (!securityRootPath || !resolvedPath) {
        continue;
      }
      const relative = path.relative(path.resolve(securityRootPath), resolvedPath);
      if (
        relative !== "" &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      ) {
        candidates.push({ securityRootPath, artifactPath: resolvedPath });
      }
    }
    return candidates;
  }
  const date = rolloutDate(record);
  if (!date) {
    return [];
  }
  const relativeArtifactPath = path.join(
    ...date,
    record.ref.providerSessionId,
    artifactId,
  );
  const candidates: CodexVisualArtifactCandidate[] = [];
  const workspaceRoot = codexStoredSessionWorkspaceRoot(record);
  if (workspaceRoot) {
    candidates.push({
      securityRootPath: path.resolve(workspaceRoot),
      artifactPath: path.join(
        path.resolve(workspaceRoot),
        ".codex",
        "visualizations",
        relativeArtifactPath,
      ),
    });
  }
  const storageRoot = resolveCodexVisualArtifactRoot(record);
  if (storageRoot) {
    candidates.push({
      securityRootPath: storageRoot,
      artifactPath: path.join(storageRoot, relativeArtifactPath),
    });
  }
  return candidates.filter(
    (candidate, index) =>
      candidates.findIndex(
        (other) => path.resolve(other.artifactPath) === path.resolve(candidate.artifactPath),
      ) === index,
  );
}
