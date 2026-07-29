import path from "node:path";
import type { CodexStoredSessionRecord } from "./codex-stored-session-types";
import { isSafeCodexVisualArtifactId } from "./codex-visual-artifacts";

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
