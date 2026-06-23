import type { SessionRuntimeState } from "@rah/runtime-protocol";

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function runtimeStateFromCodexThreadStatus(
  status: unknown,
): SessionRuntimeState | undefined {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return undefined;
  }
  const record = status as Record<string, unknown>;
  if (record.type === "notLoaded") {
    return "starting";
  }
  if (record.type === "idle") {
    return "idle";
  }
  if (record.type === "systemError") {
    return "failed";
  }
  if (record.type === "active") {
    const flags = stringArrayField(record, "activeFlags");
    if (flags.includes("waitingOnApproval")) {
      return "waiting_permission";
    }
    if (flags.includes("waitingOnUserInput")) {
      return "waiting_input";
    }
    return "running";
  }
  return undefined;
}
