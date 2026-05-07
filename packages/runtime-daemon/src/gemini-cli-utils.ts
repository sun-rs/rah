import { resolveConfiguredBinary } from "./provider-binary-utils";

export async function resolveGeminiBinary(): Promise<string> {
  return await resolveConfiguredBinary("RAH_GEMINI_BINARY", "gemini");
}

export function buildGeminiArgs(params: {
  prompt: string;
  approvalMode: string;
  model?: string | null;
  providerSessionId?: string | null;
}): string[] {
  const args = ["--output-format", "stream-json", "--approval-mode", params.approvalMode];
  if (params.model) {
    args.push("--model", params.model);
  }
  if (params.providerSessionId) {
    args.push("--resume", params.providerSessionId);
  }
  args.push("--prompt", params.prompt);
  return args;
}

export function geminiHeadlessEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GEMINI_CLI_TRUST_WORKSPACE: process.env.GEMINI_CLI_TRUST_WORKSPACE ?? "true",
  };
}

export function isNoisyGeminiCliStderr(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("YOLO mode is enabled.") ||
    trimmed.includes("[IDEClient] Failed to connect to IDE companion extension.") ||
    trimmed === "Ripgrep is not available. Falling back to GrepTool." ||
    trimmed.startsWith("Warning: Basic terminal detected ") ||
    trimmed.startsWith("Warning: 256-color support not detected.") ||
    trimmed === "headers: {" ||
    trimmed === "}" ||
    trimmed === "}," ||
    /^'[-a-z0-9]+': /i.test(trimmed) ||
    /^status: \d{3},?$/.test(trimmed) ||
    /^statusText: '[^']+',?$/.test(trimmed)
  );
}
