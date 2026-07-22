export type NativeTuiExitEvidence = {
  expectedClose: boolean;
  outputError?: string;
  exitCode?: number | null;
  signal?: string | null;
};

export function classifyNativeTuiExit(evidence: NativeTuiExitEvidence): string | undefined {
  if (evidence.expectedClose) {
    return undefined;
  }
  if (evidence.outputError) {
    return evidence.outputError;
  }
  if (evidence.signal) {
    return `Native TUI process exited from signal ${evidence.signal}.`;
  }
  if (evidence.exitCode === 0) {
    return undefined;
  }
  if (typeof evidence.exitCode === "number") {
    return `Native TUI process exited with code ${evidence.exitCode}.`;
  }
  return "Native TUI process exited unexpectedly.";
}
