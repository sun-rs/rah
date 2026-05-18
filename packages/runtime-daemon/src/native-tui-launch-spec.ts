import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  ProviderKind,
  ResumeSessionRequest,
  SessionConfigValue,
  SessionModeDescriptor,
  StartSessionRequest,
} from "@rah/runtime-protocol";
import {
  claudeLaunchSpec,
  codexLaunchSpec,
  opencodeLaunchSpec,
} from "./provider-diagnostics";
import {
  buildOpenCodeProviderModelId,
  fetchOpenCodeModelCatalog,
} from "./opencode-model-catalog";
import {
  normalizeMcpServerName,
  opencodeEnvForMcpServers,
  type ProviderMcpServerSpec,
} from "./provider-mcp-server-spec";
import { discoverCodexStoredSessions } from "./codex-stored-sessions";
import {
  codexHomeForRolloutPath,
  createIsolatedCodexWrapperHome,
} from "./codex-wrapper-home";
import { optionValueAsString } from "./session-model-options";
import {
  isClaudeModeId,
  isCodexPlanModeId,
  isOpenCodeModeId,
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
  modeId?: string;
  modelId?: string;
  reasoningId?: string | null;
  optionValues?: Record<string, SessionConfigValue>;
}

type ModelRequest = {
  model?: string;
  reasoningId?: string | null;
  optionValues?: Record<string, SessionConfigValue>;
};

export type NativeTuiMcpServerSpec = ProviderMcpServerSpec;

export type NativeTuiStartLaunchSpecRequest = StartSessionRequest & {
  extraMcpServers?: NativeTuiMcpServerSpec[];
  initialPrompt?: string;
  availableModes?: readonly SessionModeDescriptor[];
};

export type NativeTuiResumeLaunchSpecRequest = ResumeSessionRequest & {
  availableModes?: readonly SessionModeDescriptor[];
};

function claudeConfigPath(): string {
  return process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
    : path.join(homedir(), ".claude.json");
}

function normalizeClaudeProjectPath(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

function readJsonObject(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function trustClaudeWorkspace(cwd: string): void {
  const configPath = claudeConfigPath();
  const configDir = path.dirname(configPath);
  const projectPath = normalizeClaudeProjectPath(cwd);
  const config = readJsonObject(configPath);
  const projects = objectValue(config.projects);
  const existingProject = objectValue(projects[projectPath]);
  if (existingProject.hasTrustDialogAccepted === true) {
    return;
  }

  projects[projectPath] = {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    ...existingProject,
    hasTrustDialogAccepted: true,
    projectOnboardingSeenCount:
      typeof existingProject.projectOnboardingSeenCount === "number"
        ? existingProject.projectOnboardingSeenCount
        : 1,
    hasCompletedProjectOnboarding:
      typeof existingProject.hasCompletedProjectOnboarding === "boolean"
        ? existingProject.hasCompletedProjectOnboarding
        : true,
  };
  config.projects = projects;

  mkdirSync(configDir, { recursive: true });
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, configPath);
}

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

function configString(value: string): string {
  return JSON.stringify(value);
}

function configStringArray(values: readonly string[] | undefined): string {
  return JSON.stringify(values ?? []);
}

function configInlineStringTable(values: Record<string, string> | undefined): string | null {
  const entries = Object.entries(values ?? {});
  if (entries.length === 0) {
    return null;
  }
  return `{ ${entries
    .map(([key, value]) => `${key} = ${configString(value)}`)
    .join(", ")} }`;
}

function resolveRahHome(): string {
  return process.env.RAH_HOME || path.join(homedir(), ".rah");
}

function appendCodexMcpArgs(args: string[], servers: readonly NativeTuiMcpServerSpec[] | undefined): void {
  for (const server of servers ?? []) {
    const name = normalizeMcpServerName(server.name);
    args.push(
      "-c",
      `mcp_servers.${name}.command=${configString(server.command)}`,
      "-c",
      `mcp_servers.${name}.args=${configStringArray(server.args)}`,
    );
    const env = configInlineStringTable(server.env);
    if (env) {
      args.push("-c", `mcp_servers.${name}.env=${env}`);
    }
  }
}

function writeClaudeMcpConfig(mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>): string {
  const dir = path.join(resolveRahHome(), "runtime-daemon", "claude-mcp-configs");
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `mcp-${process.pid}-${Date.now()}-${randomUUID()}.json`);
  writeFileSync(filePath, `${JSON.stringify({ mcpServers }, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

function appendClaudeMcpArgs(args: string[], servers: readonly NativeTuiMcpServerSpec[] | undefined): void {
  if (!servers || servers.length === 0) {
    return;
  }
  const mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};
  for (const server of servers) {
    mcpServers[normalizeMcpServerName(server.name)] = {
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
    };
  }
  args.push("--mcp-config", writeClaudeMcpConfig(mcpServers));
}

function resolveOptionOrReasoning(
  request: ModelRequest,
  optionId: string,
): string | null | undefined {
  return optionString(request.optionValues, optionId) ??
    (request.reasoningId === undefined ? undefined : request.reasoningId);
}

function launchConfigMetadata(
  request: ModelRequest & { modeId?: string },
  optionId: string,
): Pick<NativeTuiLaunchSpec, "modeId" | "modelId" | "reasoningId" | "optionValues"> {
  const reasoningId = resolveOptionOrReasoning(request, optionId);
  return {
    ...(request.modeId ? { modeId: request.modeId } : {}),
    ...(request.model ? { modelId: request.model } : {}),
    ...(reasoningId !== undefined ? { reasoningId } : {}),
    ...(request.optionValues !== undefined ? { optionValues: request.optionValues } : {}),
  };
}

function appendCodexCommonArgs(
  args: string[],
  request: Pick<StartSessionRequest, "cwd" | "model" | "reasoningId" | "optionValues">,
): void {
  args.push("--cd", request.cwd);
  if (request.model) {
    args.push("--model", request.model);
  }
  const effort = resolveOptionOrReasoning(request, "model_reasoning_effort");
  if (effort) {
    args.push("-c", `model_reasoning_effort=${configString(effort)}`);
  }
}

function appendCodexModeArgs(
  args: string[],
  request: Pick<StartSessionRequest, "modeId">,
): void {
  if (!request.modeId) {
    return;
  }
  if (isCodexPlanModeId(request.modeId)) {
    throw new Error("Codex plan mode is a native TUI interactive toggle and cannot be pre-set at launch.");
  }
  const parsed = parseCodexModeId(request.modeId);
  if (!parsed) {
    throw new Error(`Unsupported Codex launch mode '${request.modeId}'.`);
  }
  if (
    parsed.approvalPolicy === "never" &&
    parsed.sandboxMode === "danger-full-access"
  ) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
    return;
  }
  args.push("--ask-for-approval", parsed.approvalPolicy, "--sandbox", parsed.sandboxMode);
  if (parsed.approvalsReviewer === "auto_review") {
    args.push("-c", "approvals_reviewer=\"auto_review\"");
  }
}

function appendInitialPrompt(args: string[], prompt: string | undefined): void {
  if (prompt?.trim()) {
    args.push(prompt);
  }
}

function appendClaudeArgs(
  args: string[],
  request: Pick<StartSessionRequest, "modeId"> & ModelRequest,
  providerSessionId: string,
  mode: "start" | "resume",
): void {
  const permissionMode =
    request.modeId && isClaudeModeId(request.modeId) ? request.modeId : undefined;
  if (request.modeId && !permissionMode) {
    throw new Error(`Unsupported Claude launch mode '${request.modeId}'.`);
  }
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

async function resolveOpenCodeLaunchModes(request: {
  cwd: string;
  modeId?: string;
  availableModes?: readonly SessionModeDescriptor[];
}): Promise<readonly SessionModeDescriptor[] | undefined> {
  if (!request.modeId) {
    return request.availableModes;
  }
  if (request.availableModes && request.availableModes.length > 0) {
    return request.availableModes;
  }
  try {
    return (await fetchOpenCodeModelCatalog({ cwd: request.cwd })).modes;
  } catch {
    return undefined;
  }
}

async function appendOpenCodeArgs(
  args: string[],
  request: { cwd: string; initialPrompt?: string; modeId?: string; availableModes?: readonly SessionModeDescriptor[] } & ModelRequest,
  providerSessionId?: string,
): Promise<void> {
  if (request.model) {
    args.push("--model", buildOpenCodeProviderModelId({
      modelId: request.model,
      reasoningId: resolveOptionOrReasoning(request, "model_reasoning_variant"),
    }));
  }
  if (providerSessionId) {
    args.push("--session", providerSessionId);
  }
  if (request.modeId) {
    const availableModes = await resolveOpenCodeLaunchModes(request);
    if (!isOpenCodeModeId(request.modeId, availableModes)) {
      throw new Error(`Unsupported OpenCode launch agent '${request.modeId}'.`);
    }
    args.push("--agent", request.modeId);
  }
  if (request.initialPrompt?.trim()) {
    args.push("--prompt", request.initialPrompt);
  }
  args.push(request.cwd);
}

function openCodeEnvForRequest(request: {
  modeId?: string;
  extraMcpServers?: readonly NativeTuiMcpServerSpec[];
}): Record<string, string> | undefined {
  return opencodeEnvForMcpServers(request.extraMcpServers);
}

export async function nativeTuiStartLaunchSpec(
  request: NativeTuiStartLaunchSpecRequest,
): Promise<NativeTuiLaunchSpec> {
  if (request.provider === "codex") {
    const { command, args } = splitLaunchArgv(await codexLaunchSpec(), "codex");
    appendCodexCommonArgs(args, request);
    appendCodexModeArgs(args, request);
    appendCodexMcpArgs(args, request.extraMcpServers);
    appendInitialPrompt(args, request.initialPrompt);
    const codexHome = createIsolatedCodexWrapperHome();
    return {
      provider: "codex",
      command,
      args,
      cwd: request.cwd,
      title: request.title ?? "Codex native TUI session",
      preview: previewCommand(command, args),
      env: { CODEX_HOME: codexHome },
      ...launchConfigMetadata(request, "model_reasoning_effort"),
    };
  }
  if (request.provider === "claude") {
    const providerSessionId = randomUUID();
    const { command, args } = splitLaunchArgv(await claudeLaunchSpec(), "claude");
    trustClaudeWorkspace(request.cwd);
    appendClaudeMcpArgs(args, request.extraMcpServers);
    appendClaudeArgs(args, request, providerSessionId, "start");
    appendInitialPrompt(args, request.initialPrompt);
    return {
      provider: "claude",
      command,
      args,
      cwd: request.cwd,
      title: request.title ?? "Claude native TUI session",
      preview: previewCommand(command, args),
      providerSessionId,
      ...launchConfigMetadata(request, "effort"),
    };
  }
  if (request.provider === "opencode") {
    const { command, args } = splitLaunchArgv(await opencodeLaunchSpec(), "opencode");
    await appendOpenCodeArgs(args, request);
    const env = openCodeEnvForRequest(request);
    return {
      provider: "opencode",
      command,
      args,
      cwd: request.cwd,
      title: request.title ?? "OpenCode native TUI session",
      preview: previewCommand(command, args),
      ...(env ? { env } : {}),
      ...launchConfigMetadata(request, "model_reasoning_variant"),
    };
  }
  throw new Error(`Native TUI live backend is not implemented for ${request.provider}.`);
}

export async function nativeTuiResumeLaunchSpec(
  request: NativeTuiResumeLaunchSpecRequest,
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
    const effort = resolveOptionOrReasoning(request, "model_reasoning_effort");
    if (effort) {
      args.push("-c", `model_reasoning_effort=${configString(effort)}`);
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
      ...launchConfigMetadata(request, "model_reasoning_effort"),
    };
  }
  if (request.provider === "claude") {
    const { command, args } = splitLaunchArgv(await claudeLaunchSpec(), "claude");
    trustClaudeWorkspace(request.cwd);
    appendClaudeArgs(args, request, request.providerSessionId, "resume");
    return {
      provider: "claude",
      command,
      args,
      cwd: request.cwd,
      title: "Claude native TUI session",
      preview: previewCommand(command, args),
      providerSessionId: request.providerSessionId,
      ...launchConfigMetadata(request, "effort"),
    };
  }
  if (request.provider === "opencode") {
    const { command, args } = splitLaunchArgv(await opencodeLaunchSpec(), "opencode");
    await appendOpenCodeArgs(args, { ...request, cwd: request.cwd }, request.providerSessionId);
    const env = openCodeEnvForRequest(request);
    return {
      provider: "opencode",
      command,
      args,
      cwd: request.cwd,
      title: "OpenCode native TUI session",
      preview: previewCommand(command, args),
      providerSessionId: request.providerSessionId,
      ...(env ? { env } : {}),
      ...launchConfigMetadata(request, "model_reasoning_variant"),
    };
  }
  throw new Error(`Native TUI live backend is not implemented for ${request.provider}.`);
}
