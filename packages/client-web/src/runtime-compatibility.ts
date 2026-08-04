import type { RuntimeIdentityResponse } from "@rah/runtime-protocol";
import type { ErrorRecoveryDescriptor } from "./error-recovery";

function shortBuildId(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value;
}

export function deriveRuntimeCompatibilityDescriptor(
  webBuildId: string,
  runtimeIdentity: Pick<RuntimeIdentityResponse, "pid" | "webBuildId">,
): ErrorRecoveryDescriptor | null {
  const browserGeneration = webBuildId.trim();
  const daemonGeneration = runtimeIdentity.webBuildId?.trim() ?? "";
  if (!browserGeneration || browserGeneration === daemonGeneration) {
    return null;
  }
  const daemonGenerationLabel = daemonGeneration
    ? `generation ${shortBuildId(daemonGeneration)}`
    : "a pre-generation build";
  return {
    title: "RAH daemon restart required",
    body:
      `This page is Web generation ${shortBuildId(browserGeneration)}, but daemon ` +
      `${runtimeIdentity.pid} is still running ${daemonGenerationLabel}. ` +
      "Restart RAH, then reload this page.",
    compactTitle: "Restart RAH to update",
    compactBody: "Restart it on the host, then retry.",
    compactPrimaryLabel: "Retry",
    primaryAction: "refresh",
    primaryLabel: "Check again",
  };
}
