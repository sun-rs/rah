import type { SessionSummary } from "@rah/runtime-protocol";

export type SessionInteractionMode =
  | "interactive"
  | "observe_only"
  | "read_only_replay";

export function canSessionSendInput(summary: SessionSummary): boolean {
  return summary.session.capabilities.steerInput;
}

export function canSessionRespondToPermissions(summary: SessionSummary): boolean {
  return summary.session.capabilities.livePermissions;
}

export function canSessionRename(summary: SessionSummary): boolean {
  return summary.session.capabilities.renameSession && summary.session.providerSessionId !== undefined;
}

export function isReadOnlyReplay(summary: SessionSummary): boolean {
  return (
    summary.session.providerSessionId !== undefined &&
    !summary.session.capabilities.steerInput &&
    !summary.session.capabilities.livePermissions
  );
}

export function sessionInteractionMode(summary: SessionSummary): SessionInteractionMode {
  if (isReadOnlyReplay(summary)) {
    return "read_only_replay";
  }
  if (!canSessionSendInput(summary)) {
    return "observe_only";
  }
  return "interactive";
}

export function sessionInteractionLabel(summary: SessionSummary): string {
  switch (sessionInteractionMode(summary)) {
    case "read_only_replay":
      return "read-only replay";
    case "observe_only":
      return "observe-only";
    case "interactive":
      return "interactive";
  }
}

export function sessionCapabilityTags(summary: SessionSummary): string[] {
  const tags: string[] = [];
  if (summary.session.capabilities.steerInput) {
    tags.push("input");
  }
  if (summary.session.capabilities.livePermissions) {
    tags.push("approvals");
  }
  if (summary.session.capabilities.resumeByProvider) {
    tags.push("resume");
  }
  return tags;
}

export function sessionInteractionNotice(summary: SessionSummary): string | null {
  if (isReadOnlyReplay(summary)) {
    return "History only. Claim control for live input and approvals.";
  }
  if (!canSessionSendInput(summary)) {
    return "Observe only.";
  }
  return null;
}

export function isSessionActivelyRunning(summary: SessionSummary): boolean {
  return [
    "starting",
    "running",
    "thinking",
    "streaming",
    "retrying",
  ].includes(summary.session.runtimeState);
}
