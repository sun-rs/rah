import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AttachSessionRequest,
  ManagedSession,
  RahEvent,
  SessionHistoryPageResponse,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import type {
  FrozenHistoryBoundary,
  FrozenHistoryPageLoader,
} from "./history-snapshots";
import type { RuntimeServices } from "./provider-adapter";
import { EventBus } from "./event-bus";
import { applyProviderActivity, type ProviderActivity } from "./provider-activity";
import { createLineHistoryWindowTranslator } from "./line-history-checkpoint";
import { createLineFrozenHistoryPageLoader } from "./line-history-pager";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";
import { selectSemanticRecentWindow } from "./semantic-history-window";
import { readLeadingLines, readTrailingLinesWindow } from "./file-snippets";
import {
  getCachedStoredSessionRef,
  loadStoredSessionMetadataCache,
  setCachedStoredSessionRef,
  writeStoredSessionMetadataCache,
} from "./stored-session-metadata-cache";

const REHYDRATED_CAPABILITIES = {
  livePermissions: false,
  steerInput: false,
  queuedInput: false,
  renameSession: true,
  modelSwitch: false,
  planMode: false,
  subagents: false,
} as const;

const SYSTEM_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

type KimiWorkDirMeta = {
  path: string;
  kaos?: string;
};

export type KimiStoredSessionRecord = {
  ref: StoredSessionRef;
  wirePath: string;
};

function resolveKimiHome(): string {
  return process.env.KIMI_SHARE_DIR ?? path.join(os.homedir(), ".kimi");
}

export function resolveKimiStoredSessionWatchRoots(): string[] {
  return [resolveKimiHome()];
}

function kimiMetadataPath(): string {
  return path.join(resolveKimiHome(), "kimi.json");
}

function kimiSessionsRoot(): string {
  return path.join(resolveKimiHome(), "sessions");
}

function normalizeDirectory(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/[\\/]+$/, "");
}

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

function localKaosName(): string {
  return "local";
}

function sessionsDirForWorkDir(meta: KimiWorkDirMeta): string {
  const digest = md5(meta.path);
  const kaos = meta.kaos ?? localKaosName();
  const basename = kaos === localKaosName() ? digest : `${kaos}_${digest}`;
  return path.join(kimiSessionsRoot(), basename);
}

function loadKimiWorkDirs(): KimiWorkDirMeta[] {
  const filePath = kimiMetadataPath();
  if (!existsSync(filePath)) {
    return [];
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const workDirs = Array.isArray(raw.work_dirs) ? raw.work_dirs : [];
    return workDirs.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return [];
      }
      const record = value as Record<string, unknown>;
      if (typeof record.path !== "string") {
        return [];
      }
      return [
        {
          path: record.path,
          ...(typeof record.kaos === "string" ? { kaos: record.kaos } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join("");
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.think === "string") {
    return record.think;
  }
  if (typeof record.description === "string") {
    return record.description;
  }
  if (typeof record.output === "string") {
    return record.output;
  }
  if (typeof record.message === "string") {
    return record.message;
  }
  if (record.function && typeof record.function === "object" && !Array.isArray(record.function)) {
    return extractText(record.function);
  }
  if (record.response && typeof record.response === "object" && !Array.isArray(record.response)) {
    return extractText(record.response);
  }
  if (record.display && Array.isArray(record.display)) {
    return extractText(record.display);
  }
  return "";
}

function truncateText(text: string, maxLength = 120): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function makeKimiFrozenHistoryBoundary(
  wirePath: string,
  endOffset: number,
): FrozenHistoryBoundary {
  return {
    kind: "frozen",
    sourceRevision: JSON.stringify({
      provider: "kimi",
      wirePath,
      endOffset,
    }),
  };
}

function parseKimiWireLine(line: string):
  | { timestamp: string; type: string; payload: Record<string, unknown> }
  | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    if (raw.type === "metadata") {
      return null;
    }
    if (typeof raw.timestamp !== "number") {
      return null;
    }
    const message = raw.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return null;
    }
    const envelope = message as Record<string, unknown>;
    if (typeof envelope.type !== "string") {
      return null;
    }
    const payload =
      envelope.payload && typeof envelope.payload === "object" && !Array.isArray(envelope.payload)
        ? (envelope.payload as Record<string, unknown>)
        : {};
    return {
      timestamp: new Date(raw.timestamp * 1000).toISOString(),
      type: envelope.type,
      payload,
    };
  } catch {
    return null;
  }
}

function deriveTitleFromWire(wirePath: string): string {
  try {
    const lines = readLeadingLines(wirePath, { maxBytes: 256 * 1024 });
    for (const line of lines) {
      const parsed = parseKimiWireLine(line.trim());
      if (!parsed || parsed.type !== "TurnBegin") {
        continue;
      }
      const userInput = extractText(parsed.payload.user_input);
      if (userInput) {
        return truncateText(userInput, 72);
      }
    }
  } catch {}
  return "Untitled";
}

function deriveCreatedAtFromWire(wirePath: string): string | undefined {
  try {
    const lines = readLeadingLines(wirePath, { maxBytes: 256 * 1024 });
    for (const line of lines) {
      const parsed = parseKimiWireLine(line.trim());
      if (parsed?.timestamp) {
        return parsed.timestamp;
      }
    }
  } catch {}
  return undefined;
}

type KimiSessionState = {
  custom_title?: string | null;
  title_generated?: boolean;
};

function sessionStatePath(sessionDir: string): string {
  return path.join(sessionDir, "state.json");
}

function loadKimiSessionState(sessionDir: string): KimiSessionState {
  try {
    const parsed = JSON.parse(readFileSync(sessionStatePath(sessionDir), "utf8")) as Record<string, unknown>;
    return {
      ...(typeof parsed.custom_title === "string" ? { custom_title: parsed.custom_title } : {}),
      ...(typeof parsed.title_generated === "boolean"
        ? { title_generated: parsed.title_generated }
        : {}),
    };
  } catch {
    return {};
  }
}

function resolveKimiSessionTitle(
  sessionDir: string,
  wirePath: string,
): {
  title: string;
  preview: string;
} {
  const state = loadKimiSessionState(sessionDir);
  const preview = deriveTitleFromWire(wirePath);
  const customTitle =
    typeof state.custom_title === "string" && state.custom_title.trim().length > 0
      ? state.custom_title.trim()
      : null;
  return {
    title: customTitle ?? preview,
    preview,
  };
}

function writeKimiSessionState(sessionDir: string, patch: KimiSessionState): void {
  const current = loadKimiSessionState(sessionDir);
  writeFileSync(
    sessionStatePath(sessionDir),
    JSON.stringify(
      {
        ...current,
        ...patch,
      },
      null,
      2,
    ),
  );
}

export function updateKimiSessionTitle(
  providerSessionId: string,
  title: string,
  cwd?: string,
): { sessionDir: string } {
  const normalizedCwd = normalizeDirectory(cwd);
  const candidateSessionDirs = new Set<string>();
  const workDirs = loadKimiWorkDirs();

  if (normalizedCwd) {
    for (const workDir of workDirs) {
      if (normalizeDirectory(workDir.path) === normalizedCwd) {
        candidateSessionDirs.add(path.join(sessionsDirForWorkDir(workDir), providerSessionId));
      }
    }
  }

  for (const workDir of workDirs) {
    candidateSessionDirs.add(path.join(sessionsDirForWorkDir(workDir), providerSessionId));
  }

  if (existsSync(kimiSessionsRoot())) {
    for (const entry of readdirSync(kimiSessionsRoot(), { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      candidateSessionDirs.add(path.join(kimiSessionsRoot(), entry.name, providerSessionId));
    }
  }

  for (const sessionDir of candidateSessionDirs) {
    if (!existsSync(sessionDir)) {
      continue;
    }
    writeKimiSessionState(sessionDir, {
      custom_title: title,
      title_generated: true,
    });
    return { sessionDir };
  }

  throw new Error(`Unknown Kimi session ${providerSessionId}.`);
}

export function discoverKimiStoredSessions(): KimiStoredSessionRecord[] {
  const cache = loadStoredSessionMetadataCache("kimi");
  const records: KimiStoredSessionRecord[] = [];
  for (const workDir of loadKimiWorkDirs()) {
    const sessionsDir = sessionsDirForWorkDir(workDir);
    let sessionIds: string[] = [];
    try {
      sessionIds = readdirSync(sessionsDir).filter((entry) => {
        try {
          return statSync(path.join(sessionsDir, entry)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      continue;
    }
    for (const sessionId of sessionIds) {
      const sessionDir = path.join(sessionsDir, sessionId);
      const wirePath = path.join(sessionDir, "wire.jsonl");
      if (!existsSync(wirePath)) {
        continue;
      }
      const stats = statSync(wirePath);
      const stateStats = existsSync(sessionStatePath(sessionDir))
        ? statSync(sessionStatePath(sessionDir))
        : null;
      const cachedRef = getCachedStoredSessionRef({
        cache,
        filePath: wirePath,
        size: stats.size + (stateStats?.size ?? 0),
        mtimeMs: Math.max(stats.mtimeMs, stateStats?.mtimeMs ?? 0),
      });
      if (cachedRef) {
        if (!cachedRef.createdAt) {
          const createdAt = deriveCreatedAtFromWire(wirePath);
          if (createdAt) {
            const nextRef = {
              ...cachedRef,
              createdAt,
            };
            setCachedStoredSessionRef({
              cache,
              filePath: wirePath,
              size: stats.size + (stateStats?.size ?? 0),
              mtimeMs: Math.max(stats.mtimeMs, stateStats?.mtimeMs ?? 0),
              ref: nextRef,
            });
            records.push({
              ref: nextRef,
              wirePath,
            });
            continue;
          }
        }
        records.push({
          ref: cachedRef,
          wirePath,
        });
        continue;
      }
      const { title, preview } = resolveKimiSessionTitle(sessionDir, wirePath);
      const createdAt = deriveCreatedAtFromWire(wirePath);
      const ref: StoredSessionRef = {
        provider: "kimi",
        providerSessionId: sessionId,
        cwd: workDir.path,
        rootDir: workDir.path,
        title,
        preview,
        ...(createdAt ? { createdAt } : {}),
        updatedAt: stats.mtime.toISOString(),
        source: "provider_history",
      };
      setCachedStoredSessionRef({
        cache,
        filePath: wirePath,
        size: stats.size + (stateStats?.size ?? 0),
        mtimeMs: Math.max(stats.mtimeMs, stateStats?.mtimeMs ?? 0),
        ref,
      });
      records.push({ ref, wirePath });
    }
  }
  writeStoredSessionMetadataCache(
    "kimi",
    new Map(
      records.map((record) => {
        const stats = statSync(record.wirePath);
        const stateStats = existsSync(sessionStatePath(path.dirname(record.wirePath)))
          ? statSync(sessionStatePath(path.dirname(record.wirePath)))
          : null;
        return [
          record.wirePath,
          {
            ref: record.ref,
            size: stats.size + (stateStats?.size ?? 0),
            mtimeMs: Math.max(stats.mtimeMs, stateStats?.mtimeMs ?? 0),
          },
        ] as const;
      }),
    ),
  );
  return records.sort((a, b) => (b.ref.updatedAt ?? "").localeCompare(a.ref.updatedAt ?? ""));
}

function classifyKimiToolFamily(name: string) {
  const normalized = name.toLowerCase();
  if (normalized.includes("read")) return "file_read" as const;
  if (normalized.includes("write")) return "file_write" as const;
  if (normalized.includes("replace") || normalized.includes("edit")) return "file_edit" as const;
  if (normalized.includes("shell") || normalized.includes("bash")) return "shell" as const;
  if (normalized.includes("grep") || normalized.includes("glob") || normalized.includes("search"))
    return "search" as const;
  if (normalized.includes("fetch")) return "web_fetch" as const;
  if (normalized.includes("web")) return "web_search" as const;
  if (normalized.includes("todo")) return "todo" as const;
  if (normalized.includes("agent") || normalized.includes("subagent")) return "subagent" as const;
  return "other" as const;
}

function translateKimiWireLines(
  sessionId: string,
  lines: string[],
): RahEvent[] {
  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const temp = services.sessionStore.createManagedSession({
    provider: "kimi",
    launchSource: "web",
    cwd: process.cwd(),
    rootDir: process.cwd(),
  });

  let currentTurnId: string | undefined;
  let currentStepIndex: number | undefined;
  let turnCounter = 0;
  const pendingTools = new Map<string, { name: string; args?: Record<string, unknown> }>();

  for (const line of lines) {
    const parsed = parseKimiWireLine(line.trim());
    if (!parsed) {
      continue;
    }
    const meta = {
      provider: "kimi" as const,
      channel: "structured_persisted" as const,
      authority: "authoritative" as const,
      ts: parsed.timestamp,
      raw: parsed,
    };
    switch (parsed.type) {
      case "TurnBegin": {
        currentTurnId = `kimi-history:${temp.session.id}:${turnCounter++}`;
        currentStepIndex = undefined;
        const text = extractText(parsed.payload.user_input);
        if (text) {
          applyProviderActivity(services, temp.session.id, meta, {
            type: "timeline_item",
            turnId: currentTurnId,
            item: { kind: "user_message", text },
          });
        }
        break;
      }
      case "SteerInput": {
        if (!currentTurnId) {
          currentTurnId = `kimi-history:${temp.session.id}:${turnCounter++}`;
        }
        const text = extractText(parsed.payload.user_input);
        if (text) {
          applyProviderActivity(services, temp.session.id, meta, {
            type: "timeline_item",
            turnId: currentTurnId,
            item: { kind: "user_message", text },
          });
        }
        break;
      }
      case "StepBegin": {
        currentStepIndex =
          typeof parsed.payload.n === "number" ? parsed.payload.n : currentStepIndex;
        if (currentTurnId) {
          applyProviderActivity(services, temp.session.id, meta, {
            type: "turn_step_started",
            turnId: currentTurnId,
            ...(currentStepIndex !== undefined ? { index: currentStepIndex } : {}),
          });
        }
        break;
      }
      case "StepInterrupted": {
        if (currentTurnId) {
          applyProviderActivity(services, temp.session.id, meta, {
            type: "turn_step_interrupted",
            turnId: currentTurnId,
            ...(currentStepIndex !== undefined ? { index: currentStepIndex } : {}),
          });
        }
        break;
      }
      case "TextPart":
      case "ContentPart": {
        if (!currentTurnId) {
          currentTurnId = `kimi-history:${temp.session.id}:${turnCounter++}`;
        }
        const partType =
          parsed.type === "ContentPart" && typeof parsed.payload.type === "string"
            ? parsed.payload.type
            : "text";
        const text = extractText(parsed.payload);
        if (!text) {
          break;
        }
        if (partType === "think") {
          applyProviderActivity(services, temp.session.id, meta, {
            type: "timeline_item",
            turnId: currentTurnId,
            item: { kind: "reasoning", text },
          });
          break;
        }
        if (partType === "text") {
          applyProviderActivity(services, temp.session.id, meta, {
            type: "timeline_item",
            turnId: currentTurnId,
            item: { kind: "assistant_message", text },
          });
        }
        break;
      }
      case "ThinkPart": {
        if (!currentTurnId) {
          currentTurnId = `kimi-history:${temp.session.id}:${turnCounter++}`;
        }
        const text = extractText(parsed.payload);
        if (text) {
          applyProviderActivity(services, temp.session.id, meta, {
            type: "timeline_item",
            turnId: currentTurnId,
            item: { kind: "reasoning", text },
          });
        }
        break;
      }
      case "ToolCall": {
        if (!currentTurnId) {
          currentTurnId = `kimi-history:${temp.session.id}:${turnCounter++}`;
        }
        const functionBody =
          parsed.payload.function && typeof parsed.payload.function === "object"
            ? (parsed.payload.function as Record<string, unknown>)
            : {};
        const name =
          typeof functionBody.name === "string"
            ? functionBody.name
            : typeof parsed.payload.name === "string"
              ? parsed.payload.name
              : "unknown";
        let args: Record<string, unknown> | undefined;
        if (typeof functionBody.arguments === "string") {
          try {
            const parsedArgs = JSON.parse(functionBody.arguments);
            if (parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)) {
              args = parsedArgs as Record<string, unknown>;
            }
          } catch {}
        }
        const id = typeof parsed.payload.id === "string" ? parsed.payload.id : crypto.randomUUID();
        pendingTools.set(id, { name, ...(args ? { args } : {}) });
        applyProviderActivity(services, temp.session.id, meta, {
          type: "tool_call_started",
          turnId: currentTurnId,
          toolCall: {
            id,
            family: classifyKimiToolFamily(name),
            providerToolName: name,
            title: name,
            ...(args ? { input: args } : {}),
          },
        });
        break;
      }
      case "ToolResult": {
        const toolCallId =
          typeof parsed.payload.tool_call_id === "string" ? parsed.payload.tool_call_id : undefined;
        if (!toolCallId) {
          break;
        }
        const pending = pendingTools.get(toolCallId);
        const returnValue =
          parsed.payload.return_value &&
          typeof parsed.payload.return_value === "object" &&
          !Array.isArray(parsed.payload.return_value)
            ? (parsed.payload.return_value as Record<string, unknown>)
            : {};
        const text = extractText(returnValue);
        const isError = Boolean(returnValue.is_error);
        if (isError) {
          applyProviderActivity(services, temp.session.id, meta, {
            type: "tool_call_failed",
            ...(currentTurnId ? { turnId: currentTurnId } : {}),
            toolCallId,
            error: text || "Tool failed",
            ...(text
              ? {
                  detail: {
                    artifacts: [{ kind: "text", label: "output", text }],
                  },
                }
              : {}),
          });
          break;
        }
        applyProviderActivity(services, temp.session.id, meta, {
          type: "tool_call_completed",
          ...(currentTurnId ? { turnId: currentTurnId } : {}),
          toolCall: {
            id: toolCallId,
            family: classifyKimiToolFamily(pending?.name ?? "unknown"),
            providerToolName: pending?.name ?? "unknown",
            title: pending?.name ?? "unknown",
            ...(pending?.args ? { input: pending.args } : {}),
            ...(text
              ? {
                  detail: {
                    artifacts: [{ kind: "text", label: "output", text }],
                  },
                }
              : {}),
          },
        });
        break;
      }
      case "ApprovalRequest": {
        applyProviderActivity(services, temp.session.id, meta, {
          type: "permission_requested",
          ...(currentTurnId ? { turnId: currentTurnId } : {}),
          request: {
            id: String(parsed.payload.id ?? crypto.randomUUID()),
            kind: "tool",
            title:
              typeof parsed.payload.action === "string"
                ? parsed.payload.action
                : "Approval required",
            ...(typeof parsed.payload.description === "string"
              ? { description: parsed.payload.description }
              : {}),
          },
        });
        break;
      }
      case "ApprovalResponse": {
        applyProviderActivity(services, temp.session.id, meta, {
          type: "permission_resolved",
          ...(currentTurnId ? { turnId: currentTurnId } : {}),
          resolution: {
            requestId: String(parsed.payload.request_id ?? ""),
            behavior:
              parsed.payload.response === "reject" ? "deny" : "allow",
            ...(typeof parsed.payload.response === "string"
              ? { decision: parsed.payload.response }
              : {}),
          },
        });
        break;
      }
      case "QuestionRequest": {
        applyProviderActivity(services, temp.session.id, meta, {
          type: "permission_requested",
          ...(currentTurnId ? { turnId: currentTurnId } : {}),
          request: {
            id: String(parsed.payload.id ?? crypto.randomUUID()),
            kind: "question",
            title: "Question",
            input: parsed.payload as never,
          },
        });
        break;
      }
      case "PlanDisplay": {
        if (!currentTurnId) {
          currentTurnId = `kimi-history:${temp.session.id}:${turnCounter++}`;
        }
        if (typeof parsed.payload.content === "string") {
          applyProviderActivity(services, temp.session.id, meta, {
            type: "timeline_item",
            turnId: currentTurnId,
            item: { kind: "plan", text: parsed.payload.content },
          });
        }
        break;
      }
      case "Notification": {
        applyProviderActivity(services, temp.session.id, meta, {
          type: "notification",
          level:
            parsed.payload.severity === "error"
              ? "critical"
              : parsed.payload.severity === "warning"
                ? "warning"
                : "info",
          title:
            typeof parsed.payload.title === "string" ? parsed.payload.title : "Notification",
          body: typeof parsed.payload.body === "string" ? parsed.payload.body : "",
          ...(currentTurnId ? { turnId: currentTurnId } : {}),
        });
        break;
      }
      case "StatusUpdate": {
        const tokenUsage =
          parsed.payload.token_usage &&
          typeof parsed.payload.token_usage === "object" &&
          !Array.isArray(parsed.payload.token_usage)
            ? (parsed.payload.token_usage as Record<string, unknown>)
            : null;
        if (!tokenUsage) {
          break;
        }
        applyProviderActivity(services, temp.session.id, meta, {
          type: "usage",
          ...(currentTurnId ? { turnId: currentTurnId } : {}),
          usage: {
            ...(typeof parsed.payload.context_tokens === "number"
              ? { usedTokens: parsed.payload.context_tokens }
              : {}),
            ...(typeof parsed.payload.max_context_tokens === "number"
              ? { contextWindow: parsed.payload.max_context_tokens }
              : {}),
            ...(typeof parsed.payload.context_usage === "number"
              ? { percentRemaining: Math.max(0, 100 - parsed.payload.context_usage * 100) }
              : {}),
            ...(typeof tokenUsage.input_other === "number"
              ? { inputTokens: tokenUsage.input_other }
              : {}),
            ...(typeof tokenUsage.input_cache_read === "number"
              ? { cachedInputTokens: tokenUsage.input_cache_read }
              : {}),
            ...(typeof tokenUsage.output === "number" ? { outputTokens: tokenUsage.output } : {}),
          },
        });
        break;
      }
    }
  }

  return services.eventBus
    .list({ sessionIds: [temp.session.id] })
    .map((event) => ({ ...event, sessionId }));
}

function publishSessionBootstrap(
  services: RuntimeServices,
  sessionId: string,
  session: ManagedSession,
) {
  services.eventBus.publish({
    sessionId,
    type: "session.created",
    source: SYSTEM_SOURCE,
    payload: { session },
  });
  services.eventBus.publish({
    sessionId,
    type: "session.started",
    source: SYSTEM_SOURCE,
    payload: { session },
  });
}

export function resumeKimiStoredSession(params: {
  services: RuntimeServices;
  record: KimiStoredSessionRecord;
  attach?: AttachSessionRequest;
}): { sessionId: string } {
  const state = params.services.sessionStore.createManagedSession({
    provider: "kimi",
    providerSessionId: params.record.ref.providerSessionId,
    launchSource: "web",
    cwd: params.record.ref.cwd ?? process.cwd(),
    rootDir: params.record.ref.rootDir ?? params.record.ref.cwd ?? process.cwd(),
    ...(params.record.ref.title ? { title: params.record.ref.title } : {}),
    ...(params.record.ref.preview ? { preview: params.record.ref.preview } : {}),
    capabilities: REHYDRATED_CAPABILITIES,
  });
  params.services.sessionStore.setRuntimeState(state.session.id, "idle");
  const session = params.services.sessionStore.getSession(state.session.id)!;
  publishSessionBootstrap(params.services, state.session.id, session.session);
  if (params.attach) {
    params.services.sessionStore.attachClient({
      sessionId: state.session.id,
      clientId: params.attach.client.id,
      kind: params.attach.client.kind,
      connectionId: params.attach.client.connectionId,
      attachMode: params.attach.mode,
      focus: true,
    });
    params.services.eventBus.publish({
      sessionId: state.session.id,
      type: "session.attached",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: params.attach.client.id,
        clientKind: params.attach.client.kind,
      },
    });
    if (params.attach.claimControl) {
      params.services.sessionStore.claimControl(
        state.session.id,
        params.attach.client.id,
        params.attach.client.kind,
      );
      params.services.eventBus.publish({
        sessionId: state.session.id,
        type: "control.claimed",
        source: SYSTEM_SOURCE,
        payload: {
          clientId: params.attach.client.id,
          clientKind: params.attach.client.kind,
        },
      });
    }
  }
  return { sessionId: state.session.id };
}

export function getKimiStoredSessionHistoryPage(params: {
  sessionId: string;
  record: KimiStoredSessionRecord;
  beforeTs?: string;
  limit?: number;
}): SessionHistoryPageResponse {
  const lines = readFileSync(params.record.wirePath, "utf8").split(/\r?\n/).filter(Boolean);
  const all = translateKimiWireLines(params.sessionId, lines)
    .filter((event) => (params.beforeTs ? event.ts < params.beforeTs : true))
    .map((event) => ({
      ...event,
      id: `history:${event.id}`,
      seq: event.seq + 1_000_000_000,
    }))
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
  const limit = Math.max(1, params.limit ?? 1000);
  const start = Math.max(0, all.length - limit);
  const events = all.slice(start);
  return {
    sessionId: params.sessionId,
    events,
    ...(start > 0 && events[0] ? { nextBeforeTs: events[0].ts } : {}),
  };
}

function readKimiFrozenHistoryWindow(args: {
  sessionId: string;
  record: KimiStoredSessionRecord;
  endOffset: number;
  limit: number;
}): { startOffset: number; events: RahEvent[] } {
  let lineBudget = Math.max(args.limit * 4, 200);
  let lastStartOffset = args.endOffset;
  let events: RahEvent[] = [];

  for (;;) {
    const window = readTrailingLinesWindow(args.record.wirePath, {
      endOffset: args.endOffset,
      maxLines: lineBudget,
      chunkBytes: 8 * 1024,
    });
    const previousStartOffset = lastStartOffset;
    events = translateKimiWireLines(args.sessionId, window.lines)
      .map((event) => ({
        ...event,
        id: `history:${event.id}`,
        seq: event.seq + 1_000_000_000,
      }))
      .sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
    lastStartOffset = window.startOffset;
    if (
      events.length >= args.limit ||
      window.startOffset === 0 ||
      window.startOffset === previousStartOffset
    ) {
      break;
    }
    lineBudget *= 2;
    if (lineBudget >= 8192) {
      break;
    }
  }

  return {
    startOffset: lastStartOffset,
    events,
  };
}

export function createKimiStoredSessionFrozenHistoryPageLoader(args: {
  sessionId: string;
  record: KimiStoredSessionRecord;
}): FrozenHistoryPageLoader {
  const snapshotEndOffset = statSync(args.record.wirePath).size;
  const boundary = makeKimiFrozenHistoryBoundary(args.record.wirePath, snapshotEndOffset);
  const translateWindow = createLineHistoryWindowTranslator({
    sessionId: args.sessionId,
    findSafeBoundaryIndex: (lines) =>
      lines.findIndex((line) => {
        const parsed = parseKimiWireLine(line.trim());
        return parsed?.type === "TurnBegin" || parsed?.type === "SteerInput";
      }),
    translateLines: (lines) => translateKimiWireLines(args.sessionId, [...lines]),
  });
  return createLineFrozenHistoryPageLoader({
    boundary,
    snapshotEndOffset,
    readWindow: ({ endOffset, lineBudget }) => {
      const window = readTrailingLinesWindow(args.record.wirePath, {
        endOffset,
        maxLines: Math.max(lineBudget, 1),
        chunkBytes: 8 * 1024,
      });
      return {
        startOffset: window.startOffset,
        events: translateWindow(window.endOffset, window.lines),
      };
    },
    selectPage: selectSemanticRecentWindow,
  });
}
