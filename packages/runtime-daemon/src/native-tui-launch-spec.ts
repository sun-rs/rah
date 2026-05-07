import { randomUUID } from "node:crypto";
import type {
  ProviderKind,
  ResumeSessionRequest,
  SessionConfigValue,
  StartSessionRequest,
} from "@rah/runtime-protocol";
import {
  claudeLaunchSpec,
  codexLaunchSpec,
  geminiLaunchSpec,
  kimiLaunchSpec,
  opencodeLaunchSpec,
} from "./provider-diagnostics";
import { discoverCodexStoredSessions } from "./codex-stored-sessions";
import {
  codexHomeForRolloutPath,
  createIsolatedCodexWrapperHome,
} from "./codex-wrapper-home";
import { resolveKimiCliModelArgs } from "./kimi-model-catalog";
import { buildOpenCodeProviderModelId } from "./opencode-model-catalog";
import { optionValueAsString } from "./session-model-options";
import {
  isClaudeModeId,
  isGeminiModeId,
  isKimiModeId,
  parseCodexModeId,
} from "./session-mode-utils";

export interface NativeTuiLaunchSpec {
  provider: ProviderKind;
  command: string;
  args: string[];
  cwd: string;
  title: string;
  preview: string;
  providerSessionId?: string;
  env?: Record<string, string>;
}

type ModelRequest = {
  model?: string;
  reasoningId?: string | null;
  optionValues?: Record<string, SessionConfigValue>;
};

function splitLaunchArgv(launch: { argv: string[] }, provider: ProviderKind): {
  command: string;
  args: string[];
} {
  const [command, ...args] = launch.argv;
  if (!command) {
    throw new Error(`${provider} launch command is empty.`);
  }
  return { command, args };
}

function previewCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

function optionString(
  optionValues: Record<string, SessionConfigValue> | undefined,
  optionId: string,
): string | null | undefined {
  return optionValueAsString(optionValues ?? {}, optionId);
}

function appendCodexCommonArgs(args: string[], request: Pick<StartSessionRequest, "cwd" | "model">): void {
  args.push("--cd", request.cwd);
  if (request.model) {
    args.push("--model", request.model);
  }
}

function appendCodexModeArgs(
  args: string[],
  request: Pick<StartSessionRequest, "modeId">,
): void {
  if (!request.modeId || request.modeId === "plan") {
    return;
  }
  const parsed = parseCodexModeId(request.modeId);
  if (!parsed) {
    return;
  }
  if (
    parsed.approvalPolicy === "never" &&
    parsed.sandboxMode === "danger-full-access"
  ) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
    return;
  }
  args.push("--ask-for-approval", parsed.approvalPolicy, "--sandbox", parsed.sandboxMode);
}

function appendClaudeArgs(
  args: string[],
  request: Pick<StartSessionRequest, "modeId"> & ModelRequest,
  providerSessionId: string,
  mode: "start" | "resume",
): void {
  const permissionMode =
    request.modeId && isClaudeModeId(request.modeId) ? request.modeId : undefined;
  if (permissionMode) {
    args.push("--permission-mode", permissionMode);
  }
  if (request.model) {
    args.push("--model", request.model);
  }
  const effort =
    optionString(request.optionValues, "effort") ??
    (request.reasoningId === null ? null : request.reasoningId);
  if (effort) {
    args.push("--effort", effort);
  }
  args.push(mode === "resume" ? "--resume" : "--session-id", providerSessionId);
}

function appendGeminiArgs(
  args: string[],
  request: Pick<StartSessionRequest, "modeId" | "model">,
): void {
  const approvalMode =
    request.modeId && isGeminiModeId(request.modeId) ? request.modeId : undefined;
  if (approvalMode) {
    args.push("--approval-mode", approvalMode);
  }
  if (request.model) {
    args.push("--model", request.model);
  }
}

function appendKimiArgs(
  args: string[],
  request: Pick<StartSessionRequest, "modeId"> & ModelRequest,
  providerSessionId: string,
): void {
  const reasoningId =
    optionString(request.optionValues, "model_thinking") ??
    (request.reasoningId === null ? null : request.reasoningId);
  const model = resolveKimiCliModelArgs({
    modelId: request.model,
    reasoningId,
  });
  if (model.model) {
    args.push("--model", model.model);
    if (model.thinking === true) {
      args.push("--thinking");
    } else if (model.thinking === false) {
      args.push("--no-thinking");
    }
  }
  if (request.modeId && isKimiModeId(request.modeId)) {
    if (request.modeId === "yolo") {
      args.push("--yolo");
    } else if (request.modeId === "plan") {
      args.push("--plan");
    }
  }
  args.push("--session", providerSessionId);
}

function appendOpenCodeArgs(
  args: string[],
  request: { cwd: string } & ModelRequest,
  providerSessionId?: string,
): void {
  const reasoningId =
    optionString(request.optionValues, "model_reasoning_variant") ??
    (request.reasoningId === null ? null : request.reasoningId);
  if (request.model) {
    args.push(
      "--model",
      buildOpenCodeProviderModelId({
        modelId: request.model,
        reasoningId,
      }),
    );
  }
  if (providerSessionId) {
    args.push("--session", providerSessionId);
  }
  args.push(request.cwd);
}

export async function nativeTuiStartLaunchSpec(
  request: StartSessionRequest,
): Promise<NativeTuiLaunchSpec> {
  if (request.provider === "codex") {
    const { command, args } = splitLaunchArgv(await codexLaunchSpec(), "codex");
    appendCodexCommonArgs(args, request);
    appendCodexModeArgs(args, request);
    const codexHome = createIsolatedCodexWrapperHome();
    return {
      provider: "codex",
      command,
      args,
      cwd: request.cwd,
      title: request.title ?? "Codex native TUI session",
      preview: previewCommand(command, args),
      env: { CODEX_HOME: codexHome },
    };
  }
  if (request.provider === "claude") {
    const providerSessionId = randomUUID();
    const { command, args } = splitLaunchArgv(await claudeLaunchSpec(), "claude");
    appendClaudeArgs(args, request, providerSessionId, "start");
    return {
      provider: "claude",
      command,
      args,
      cwd: request.cwd,
      title: request.title ?? "Claude native TUI session",
      preview: previewCommand(command, args),
      providerSessionId,
    };
  }
  if (request.provider === "gemini") {
    const { command, args } = splitLaunchArgv(await geminiLaunchSpec(), "gemini");
    appendGeminiArgs(args, request);
    return {
      provider: "gemini",
      command,
      args,
      cwd: request.cwd,
      title: request.title ?? "Gemini native TUI session",
      preview: previewCommand(command, args),
    };
  }
  if (request.provider === "kimi") {
    const providerSessionId = randomUUID();
    const { command, args } = splitLaunchArgv(await kimiLaunchSpec(), "kimi");
    appendKimiArgs(args, request, providerSessionId);
    return {
      provider: "kimi",
      command,
      args,
      cwd: request.cwd,
      title: request.title ?? "Kimi native TUI session",
      preview: previewCommand(command, args),
      providerSessionId,
    };
  }
  if (request.provider === "opencode") {
    const { command, args } = splitLaunchArgv(await opencodeLaunchSpec(), "opencode");
    appendOpenCodeArgs(args, request);
    return {
      provider: "opencode",
      command,
      args,
      cwd: request.cwd,
      title: request.title ?? "OpenCode native TUI session",
      preview: previewCommand(command, args),
    };
  }
  throw new Error(`Native TUI live backend is not implemented for ${request.provider}.`);
}

export async function nativeTuiResumeLaunchSpec(
  request: ResumeSessionRequest,
): Promise<NativeTuiLaunchSpec> {
  if (!request.cwd) {
    throw new Error("Native TUI resume requires a working directory.");
  }
  if (request.provider === "codex") {
    const { command, args } = splitLaunchArgv(await codexLaunchSpec(), "codex");
    args.push("resume", "--cd", request.cwd);
    if (request.model) {
      args.push("--model", request.model);
    }
    appendCodexModeArgs(args, request);
    args.push(request.providerSessionId);
    const record = discoverCodexStoredSessions().find(
      (candidate) => candidate.ref.providerSessionId === request.providerSessionId,
    );
    const codexHome = record ? codexHomeForRolloutPath(record.rolloutPath) : null;
    return {
      provider: "codex",
      command,
      args,
      cwd: request.cwd,
      title: "Codex native TUI session",
      preview: previewCommand(command, args),
      ...(codexHome ? { env: { CODEX_HOME: codexHome } } : {}),
    };
  }
  if (request.provider === "claude") {
    const { command, args } = splitLaunchArgv(await claudeLaunchSpec(), "claude");
    appendClaudeArgs(args, request, request.providerSessionId, "resume");
    return {
      provider: "claude",
      command,
      args,
      cwd: request.cwd,
      title: "Claude native TUI session",
      preview: previewCommand(command, args),
      providerSessionId: request.providerSessionId,
    };
  }
  if (request.provider === "gemini") {
    const { command, args } = splitLaunchArgv(await geminiLaunchSpec(), "gemini");
    appendGeminiArgs(args, request);
    args.push("--resume", request.providerSessionId);
    return {
      provider: "gemini",
      command,
      args,
      cwd: request.cwd,
      title: "Gemini native TUI session",
      preview: previewCommand(command, args),
      providerSessionId: request.providerSessionId,
    };
  }
  if (request.provider === "kimi") {
    const { command, args } = splitLaunchArgv(await kimiLaunchSpec(), "kimi");
    appendKimiArgs(args, request, request.providerSessionId);
    return {
      provider: "kimi",
      command,
      args,
      cwd: request.cwd,
      title: "Kimi native TUI session",
      preview: previewCommand(command, args),
      providerSessionId: request.providerSessionId,
    };
  }
  if (request.provider === "opencode") {
    const { command, args } = splitLaunchArgv(await opencodeLaunchSpec(), "opencode");
    appendOpenCodeArgs(args, { ...request, cwd: request.cwd }, request.providerSessionId);
    return {
      provider: "opencode",
      command,
      args,
      cwd: request.cwd,
      title: "OpenCode native TUI session",
      preview: previewCommand(command, args),
      providerSessionId: request.providerSessionId,
    };
  }
  throw new Error(`Native TUI live backend is not implemented for ${request.provider}.`);
}
