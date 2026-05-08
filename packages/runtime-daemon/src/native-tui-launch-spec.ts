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
  opencodeLaunchSpec,
} from "./provider-diagnostics";
import { discoverCodexStoredSessions } from "./codex-stored-sessions";
import {
  codexHomeForRolloutPath,
  createIsolatedCodexWrapperHome,
} from "./codex-wrapper-home";
import { optionValueAsString } from "./session-model-options";
import {
  isClaudeModeId,
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
    if (permissionMode === "bypassPermissions") {
      args.push("--dangerously-skip-permissions");
    }
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

function appendOpenCodeArgs(
  args: string[],
  request: { cwd: string } & ModelRequest,
  providerSessionId?: string,
): void {
  if (request.model) {
    args.push("--model", request.model);
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
