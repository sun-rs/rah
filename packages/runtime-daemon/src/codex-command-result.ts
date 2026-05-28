import type { JsonObject, ObservationKind, ObservationStatus } from "@rah/runtime-protocol";

export interface CodexCommandResultDisposition {
  status: Extract<ObservationStatus, "completed" | "failed">;
  summary?: string;
  includeExitCode: boolean;
  metrics?: JsonObject;
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

function isSearchNoMatchResult(params: {
  kind: ObservationKind;
  exitCode?: number;
  output?: string;
  stderr?: string;
}): boolean {
  return (
    params.kind === "file.search" &&
    params.exitCode === 1 &&
    isBlank(params.output) &&
    isBlank(params.stderr)
  );
}

export function classifyCodexCommandResult(params: {
  kind: ObservationKind;
  exitCode?: number;
  output?: string;
  stderr?: string;
}): CodexCommandResultDisposition {
  if (isSearchNoMatchResult(params)) {
    return {
      status: "completed",
      summary: "No matches.",
      includeExitCode: false,
      metrics: {
        rawExitCode: 1,
        semanticStatus: "search_no_matches",
      },
    };
  }

  return {
    status: params.exitCode !== undefined && params.exitCode !== 0 ? "failed" : "completed",
    ...(params.exitCode !== undefined
      ? { summary: `Process exited with code ${params.exitCode}.` }
      : {}),
    includeExitCode: params.exitCode !== undefined,
  };
}
