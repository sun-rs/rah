import { randomUUID } from "node:crypto";
import {
  query as claudeQuery,
  type CanUseTool,
  type PermissionResult,
  type PermissionUpdate,
  type PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import {
  isPermissionSessionGrant,
  type AttachSessionRequest,
  type CloseSessionRequest,
  type InterruptSessionRequest,
  type PermissionResponseRequest,
  type SessionInputRequest,
  type StartSessionRequest,
} from "@rah/runtime-protocol";
import type { RuntimeServices } from "./provider-adapter";
import {
  buildClaudeModelCatalog,
  resolveClaudeCatalogModelId,
  resolveClaudeEffortValue,
  resolveClaudeRuntimeModelId,
  resolveClaudeRuntimeCapabilityState,
} from "./claude-model-catalog";
import { toSessionSummary } from "./session-store";
import { buildClaudeModeState, isClaudeModeId } from "./session-mode-utils";
import { resolveModelContextWindow } from "./model-context-window";
import { resolveModelOptionValues } from "./session-model-options";
import {
  approvalPolicyToPermissionMode,
  applyActivity,
  attachRequestedClient,
  buildClaudeOptions,
  consumeClaudeQuery,
  humanizeClaudeToolName,
  publishSessionBootstrap,
  waitForPendingClaudePermission,
} from "./claude-live-helpers";
import type {
  LiveClaudeSession,
} from "./claude-live-types";

export type {
  ClaudeQueryFactory,
  LiveClaudeSession,
  LiveClaudeTurn,
  PendingClaudePermission,
} from "./claude-live-types";

function resolveClaudeStartupMode(args: {
  modeId?: string | undefined;
  approvalPolicy?: StartSessionRequest["approvalPolicy"] | undefined;
  fallback?: PermissionMode | undefined;
}): PermissionMode {
  const requestedModeId = args.modeId?.trim();
  if (requestedModeId) {
    if (!isClaudeModeId(requestedModeId)) {
      throw new Error(`Unsupported Claude mode '${requestedModeId}'.`);
    }
    return requestedModeId as PermissionMode;
  }
  if (args.approvalPolicy !== undefined) {
    return approvalPolicyToPermissionMode(args.approvalPolicy);
  }
  return args.fallback ?? "bypassPermissions";
}

export async function startClaudeLiveSession(args: {
  services: RuntimeServices;
  request: StartSessionRequest;
  queryFactory?: typeof claudeQuery;
}) {
  const permissionMode = resolveClaudeStartupMode({
    modeId: args.request.modeId,
    approvalPolicy: args.request.approvalPolicy,
  });
  const modelCatalog = await buildClaudeModelCatalog({ cwd: args.request.cwd });
  const currentModelId =
    resolveClaudeCatalogModelId(args.request.model, modelCatalog) ??
    modelCatalog.currentModelId ??
    null;
  const currentModel = modelCatalog.models.find((model) => model.id === currentModelId);
  if (args.request.optionValues !== undefined && !currentModel) {
    throw new Error(`Unsupported Claude model '${currentModelId ?? ""}'.`);
  }
  const requestedOptionValues =
    args.request.optionValues ??
    (args.request.providerConfig?.effort !== undefined
      ? { effort: args.request.providerConfig.effort }
      : undefined);
  const optionValues = currentModel
    ? resolveModelOptionValues({
        catalog: modelCatalog,
        model: currentModel,
        optionValues: requestedOptionValues,
        reasoningId: args.request.reasoningId,
      })
    : {};
  const effort = resolveClaudeEffortValue(optionValues.effort) as
    | LiveClaudeSession["effort"]
    | undefined;
  const runtimeModelId = currentModel && args.request.model
    ? resolveClaudeRuntimeModelId(currentModel)
    : undefined;
  const runtimeCapabilityState = resolveClaudeRuntimeCapabilityState({
    catalog: modelCatalog,
    modelId: currentModelId,
    effort,
    ...(Object.keys(optionValues).length > 0 ? { optionValues } : {}),
  });
  const contextWindow = resolveModelContextWindow({
    provider: "claude",
    modelId: currentModelId,
    catalog: modelCatalog,
  });
  const state = args.services.sessionStore.createManagedSession({
    provider: "claude",
    launchSource: "web",
    cwd: args.request.cwd,
    rootDir: args.request.cwd,
    ...(args.request.title ? { title: args.request.title } : {}),
    mode: buildClaudeModeState({
      currentModeId: permissionMode,
      mutable: true,
    }),
    ...(currentModelId || modelCatalog.models.length > 0
      ? {
          model: {
            currentModelId,
            currentReasoningId: effort ?? null,
            availableModels: modelCatalog.models,
            mutable: true,
            source: modelCatalog.source,
          },
        }
      : {}),
    ...(runtimeCapabilityState.modelProfile
      ? { modelProfile: runtimeCapabilityState.modelProfile }
      : {}),
    ...(runtimeCapabilityState.config ? { config: runtimeCapabilityState.config } : {}),
    capabilities: {
      livePermissions: true,
      steerInput: true,
      queuedInput: false,
      renameSession: true,
      actions: {
        info: true,
        archive: true,
        delete: true,
        rename: "native",
      },
      modelSwitch: true,
      planMode: false,
      subagents: false,
    },
  });
  publishSessionBootstrap(args.services, state.session.id, state.session);
  attachRequestedClient(args.services, state.session.id, args.request.attach);
  args.services.sessionStore.setRuntimeState(state.session.id, "idle");
  const liveSession: LiveClaudeSession = {
    sessionId: state.session.id,
    cwd: args.request.cwd,
    ...(runtimeModelId ? { model: runtimeModelId } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(effort !== undefined && runtimeCapabilityState.config ? { effort } : {}),
    permissionMode,
    activeTurn: null,
    pendingPermissions: new Map(),
    queryFactory: args.queryFactory ?? claudeQuery,
  };
  return {
    summary: toSessionSummary(args.services.sessionStore.getSession(state.session.id)!),
    liveSession,
  };
}

export async function resumeClaudeLiveSession(args: {
  services: RuntimeServices;
  providerSessionId: string;
  cwd: string;
  model?: string;
  optionValues?: StartSessionRequest["optionValues"];
  reasoningId?: string | null;
  modeId?: string;
  permissionMode?: PermissionMode;
  attach?: AttachSessionRequest;
  queryFactory?: typeof claudeQuery;
}) {
  const permissionMode = resolveClaudeStartupMode({
    modeId: args.modeId,
    fallback: args.permissionMode ?? "bypassPermissions",
  });
  const modelCatalog = await buildClaudeModelCatalog({ cwd: args.cwd });
  const currentModelId =
    resolveClaudeCatalogModelId(args.model, modelCatalog) ??
    modelCatalog.currentModelId ??
    null;
  const currentModel = modelCatalog.models.find((model) => model.id === currentModelId);
  if (args.optionValues !== undefined && !currentModel) {
    throw new Error(`Unsupported Claude model '${currentModelId ?? ""}'.`);
  }
  const optionValues = currentModel
    ? resolveModelOptionValues({
        catalog: modelCatalog,
        model: currentModel,
        optionValues: args.optionValues,
        reasoningId: args.reasoningId,
      })
    : {};
  const effort = resolveClaudeEffortValue(optionValues.effort) as
    | LiveClaudeSession["effort"]
    | undefined;
  const runtimeModelId = currentModel && args.model
    ? resolveClaudeRuntimeModelId(currentModel)
    : undefined;
  const runtimeCapabilityState = resolveClaudeRuntimeCapabilityState({
    catalog: modelCatalog,
    modelId: currentModelId,
    effort,
    ...(Object.keys(optionValues).length > 0 ? { optionValues } : {}),
  });
  const contextWindow = resolveModelContextWindow({
    provider: "claude",
    modelId: currentModelId,
    catalog: modelCatalog,
  });
  const state = args.services.sessionStore.createManagedSession({
    provider: "claude",
    providerSessionId: args.providerSessionId,
    launchSource: "web",
    cwd: args.cwd,
    rootDir: args.cwd,
    mode: buildClaudeModeState({
      currentModeId: permissionMode,
      mutable: true,
    }),
    ...(currentModelId || modelCatalog.models.length > 0
      ? {
          model: {
            currentModelId,
            currentReasoningId: effort ?? null,
            availableModels: modelCatalog.models,
            mutable: true,
            source: modelCatalog.source,
          },
        }
      : {}),
    ...(runtimeCapabilityState.modelProfile
      ? { modelProfile: runtimeCapabilityState.modelProfile }
      : {}),
    capabilities: {
      livePermissions: true,
      steerInput: true,
      queuedInput: false,
      renameSession: true,
      actions: {
        info: true,
        archive: true,
        delete: true,
        rename: "native",
      },
      modelSwitch: true,
      planMode: false,
      subagents: false,
    },
  });
  publishSessionBootstrap(args.services, state.session.id, state.session);
  attachRequestedClient(args.services, state.session.id, args.attach);
  args.services.sessionStore.setRuntimeState(state.session.id, "idle");
  const liveSession: LiveClaudeSession = {
    sessionId: state.session.id,
    cwd: args.cwd,
    providerSessionId: args.providerSessionId,
    ...(runtimeModelId ? { model: runtimeModelId } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(effort !== undefined && runtimeCapabilityState.config ? { effort } : {}),
    permissionMode,
    activeTurn: null,
    pendingPermissions: new Map(),
    queryFactory: args.queryFactory ?? claudeQuery,
  };
  return {
    summary: toSessionSummary(args.services.sessionStore.getSession(state.session.id)!),
    liveSession,
  };
}

export async function sendInputToClaudeLiveSession(args: {
  services: RuntimeServices;
  liveSession: LiveClaudeSession;
  request: SessionInputRequest;
}) {
  if (args.liveSession.activeTurn) {
    throw new Error("Claude session already has an active turn.");
  }
  if (!args.services.sessionStore.hasInputControl(args.liveSession.sessionId, args.request.clientId)) {
    throw new Error(
      `Client ${args.request.clientId} does not hold input control for ${args.liveSession.sessionId}.`,
    );
  }

  const turnId = randomUUID();
  applyActivity(
    args.services,
    args.liveSession.sessionId,
    {
      type: "turn_started",
      turnId,
    },
  );
  applyActivity(
    args.services,
    args.liveSession.sessionId,
    {
      type: "timeline_item",
      turnId,
      item: {
        kind: "user_message",
        text: args.request.text,
      },
    },
  );
  args.services.sessionStore.setRuntimeState(args.liveSession.sessionId, "running");

  const canUseTool: CanUseTool = async (toolName, input, options) => {
    const requestId = `permission-${randomUUID()}`;
    const suggestions = Array.isArray(options.suggestions)
      ? (options.suggestions as PermissionUpdate[])
      : [];
    const allowResult: PermissionResult = {
      behavior: "allow",
    };
    const allowForSessionResult =
      suggestions.length > 0
        ? ({
            behavior: "allow",
            updatedPermissions: suggestions,
          } satisfies PermissionResult)
        : undefined;
    const permissionRequest = {
      id: requestId,
      kind: "tool" as const,
      title: humanizeClaudeToolName(toolName),
      ...(options.description ?? options.title
        ? { description: options.description ?? options.title }
        : {}),
      actions: [
        { id: "allow", label: "Allow", behavior: "allow" as const, variant: "primary" as const },
        ...(allowForSessionResult
          ? [
              {
                id: "allow_for_session",
                label: "Allow for session",
                behavior: "allow" as const,
                variant: "secondary" as const,
              },
            ]
          : []),
        { id: "deny", label: "Deny", behavior: "deny" as const, variant: "danger" as const },
      ],
      detail: {
        artifacts: [{ kind: "json" as const, label: "input", value: input }],
      },
    };
    const resultPromise = new Promise<PermissionResult>((resolve, reject) => {
      args.liveSession.pendingPermissions.set(requestId, {
        sessionId: args.liveSession.sessionId,
        requestId,
        allowResult,
        ...(allowForSessionResult ? { allowForSessionResult } : {}),
        resolve,
        reject,
      });
    });
    applyActivity(
      args.services,
      args.liveSession.sessionId,
      {
        type: "permission_requested",
        turnId,
        request: permissionRequest,
      },
      { toolName, input, options },
    );
    return await resultPromise;
  };

  const options = await buildClaudeOptions({
    liveSession: args.liveSession,
    canUseTool,
  });
  const query = args.liveSession.queryFactory({
    prompt: args.request.text,
    options,
  });
  args.liveSession.activeTurn = {
    query,
    turnId,
    completed: false,
  };
  void consumeClaudeQuery({
    services: args.services,
    liveSession: args.liveSession,
    turnId,
    query,
  });
}

export function interruptClaudeLiveSession(args: {
  services: RuntimeServices;
  liveSession: LiveClaudeSession;
  request: InterruptSessionRequest;
}) {
  if (!args.services.sessionStore.hasInputControl(args.liveSession.sessionId, args.request.clientId)) {
    throw new Error(
      `Client ${args.request.clientId} does not hold input control for ${args.liveSession.sessionId}.`,
    );
  }
  args.liveSession.activeTurn?.query.close();
  args.liveSession.activeTurn = null;
  args.services.sessionStore.setRuntimeState(args.liveSession.sessionId, "idle");
  const state = args.services.sessionStore.getSession(args.liveSession.sessionId);
  if (!state) {
    throw new Error(`Unknown session ${args.liveSession.sessionId}`);
  }
  return toSessionSummary(state);
}

export async function respondToClaudeLivePermission(args: {
  liveSession: LiveClaudeSession;
  services: RuntimeServices;
  requestId: string;
  response: PermissionResponseRequest;
}) {
  const pending = await waitForPendingClaudePermission(
    args.requestId,
    args.liveSession,
  );
  if (!pending) {
    throw new Error(
      `No pending Claude permission request '${args.requestId}'. Known pending keys: ${JSON.stringify([...args.liveSession.pendingPermissions.keys()])}`,
    );
  }
  const resolution = {
    requestId: args.requestId,
    behavior: args.response.behavior,
    ...(args.response.message !== undefined ? { message: args.response.message } : {}),
    ...(args.response.selectedActionId !== undefined
      ? { selectedActionId: args.response.selectedActionId }
      : {}),
    ...(args.response.decision !== undefined ? { decision: args.response.decision } : {}),
    ...(args.response.answers !== undefined ? { answers: args.response.answers } : {}),
  };
  applyActivity(
    args.services,
    args.liveSession.sessionId,
    {
      type: "permission_resolved",
      resolution,
      ...(args.liveSession.activeTurn ? { turnId: args.liveSession.activeTurn.turnId } : {}),
    },
  );
  args.liveSession.pendingPermissions.delete(args.requestId);
  if (args.response.behavior === "allow") {
    const useSessionGrant = isPermissionSessionGrant(args.response);
    pending.resolve(
      useSessionGrant && pending.allowForSessionResult
        ? pending.allowForSessionResult
        : pending.allowResult,
    );
    return;
  }
  pending.resolve({
    behavior: "deny",
    message: args.response.message ?? "Denied by user",
  });
}

export async function closeClaudeLiveSession(
  liveSession: LiveClaudeSession,
  _request?: CloseSessionRequest,
): Promise<void> {
  liveSession.activeTurn?.query.close();
  liveSession.activeTurn = null;
  for (const pending of liveSession.pendingPermissions.values()) {
    pending.reject(new Error("Claude session closed"));
  }
  liveSession.pendingPermissions.clear();
}
