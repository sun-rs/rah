import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AttachSessionRequest,
  ManagedSession,
  RahEvent,
  SessionHistoryPageResponse,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import { EventBus } from "./event-bus";
import { PtyHub } from "./pty-hub";
import type {
  OpenCodeMessageInfo,
  OpenCodeMessageWithParts,
  OpenCodePart,
} from "./opencode-api";
import {
  completeOpenCodeTurn,
  createOpenCodeActivityState,
  translateOpenCodeMessage,
} from "./opencode-activity";
import type {
  FrozenHistoryBoundary,
  FrozenHistoryPageLoader,
} from "./history-snapshots";
import { applyProviderActivity } from "./provider-activity";
import type { RuntimeServices } from "./provider-adapter";
import { SessionStore } from "./session-store";
import { normalizeDirectory } from "./workbench-directory-utils";
import { withHistoryMeta } from "./stored-session-history-meta";

export interface OpenCodeStoredSessionRecord {
  ref: StoredSessionRef;
  databasePath: string;
}

const REHYDRATED_CAPABILITIES = {
  livePermissions: false,
  steerInput: false,
  queuedInput: false,
  renameSession: false,
  actions: {
    info: true,
    archive: false,
    delete: true,
    rename: "none",
  },
  modelSwitch: false,
  planMode: false,
  subagents: false,
} as const;

const SYSTEM_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

const HISTORY_SOURCE = {
  provider: "opencode" as const,
  channel: "structured_persisted" as const,
  authority: "authoritative" as const,
};

type OpenCodeSessionRow = {
  id: string;
  directory: string | null;
  title: string | null;
  time_created: number | null;
  time_updated: number | null;
  time_archived: number | null;
  project_worktree: string | null;
  preview: string | null;
  message_count: number | null;
  history_bytes: number | null;
};

type OpenCodeMessageRow = {
  id: string;
  session_id: string;
  time_created: number | null;
  time_updated: number | null;
  data: string | null;
};

type OpenCodePartRow = {
  id: string;
  session_id: string;
  message_id: string;
  data: string | null;
};

type OpenCodeFrozenHistoryCursor = {
  beforeTs: string;
};

function encodeOpenCodeFrozenHistoryCursor(cursor: OpenCodeFrozenHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeOpenCodeFrozenHistoryCursor(cursor: string): OpenCodeFrozenHistoryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      beforeTs?: unknown;
    };
    if (typeof parsed.beforeTs !== "string" || !parsed.beforeTs) {
      throw new Error("Invalid OpenCode frozen history cursor.");
    }
    return { beforeTs: parsed.beforeTs };
  } catch {
    throw new Error("Invalid OpenCode frozen history cursor.");
  }
}

function makeOpenCodeFrozenHistoryBoundary(record: OpenCodeStoredSessionRecord): FrozenHistoryBoundary {
  return {
    kind: "frozen",
    sourceRevision: JSON.stringify({
      provider: "opencode",
      databasePath: record.databasePath,
      providerSessionId: record.ref.providerSessionId,
      sessionUpdatedAt: record.ref.updatedAt ?? null,
    }),
  };
}

export function resolveOpenCodeDataDir(): string {
  const xdgData = process.env.XDG_DATA_HOME?.trim();
  return path.join(xdgData || path.join(os.homedir(), ".local", "share"), "opencode");
}

export function resolveOpenCodeDatabasePath(dataDir = resolveOpenCodeDataDir()): string {
  return path.join(dataDir, "opencode.db");
}

export function resolveOpenCodeStoredSessionWatchRoots(): string[] {
  return [resolveOpenCodeDatabasePath()];
}

export function discoverOpenCodeStoredSessions(options: {
  dataDir?: string;
  limit?: number;
} = {}): OpenCodeStoredSessionRecord[] {
  const databasePath = resolveOpenCodeDatabasePath(options.dataDir);
  const limit = Math.max(1, options.limit ?? 1000);
  const rows = sqliteJson<OpenCodeSessionRow>(
    databasePath,
    `
      select
        s.id,
        s.directory,
        s.title,
        s.time_created,
        s.time_updated,
        s.time_archived,
        p.worktree as project_worktree,
        (
          select json_extract(pp.data, '$.text')
          from part pp
          join message mm on mm.id = pp.message_id
          where pp.session_id = s.id
            and json_extract(pp.data, '$.type') = 'text'
            and coalesce(json_extract(pp.data, '$.synthetic'), 0) = 0
            and coalesce(json_extract(pp.data, '$.ignored'), 0) = 0
          order by pp.time_created desc, pp.id desc
          limit 1
        ) as preview,
        (
          select count(*)
          from message mm
          where mm.session_id = s.id
        ) as message_count,
        (
          coalesce((
            select sum(length(mm.data))
            from message mm
            where mm.session_id = s.id
          ), 0) + coalesce((
            select sum(length(pp.data))
            from part pp
            where pp.session_id = s.id
          ), 0)
        ) as history_bytes
      from session s
      left join project p on p.id = s.project_id
      where s.parent_id is null
        and s.time_archived is null
      order by s.time_updated desc, s.id desc
      limit ${limit}
    `,
  );
  return rows.flatMap((row) => buildStoredSessionRecord(row, databasePath));
}

export function findOpenCodeStoredSessionRecord(
  providerSessionId: string,
  options: { dataDir?: string } = {},
): OpenCodeStoredSessionRecord | null {
  const databasePath = resolveOpenCodeDatabasePath(options.dataDir);
  const rows = sqliteJson<OpenCodeSessionRow>(
    databasePath,
    `
      select
        s.id,
        s.directory,
        s.title,
        s.time_created,
        s.time_updated,
        s.time_archived,
        p.worktree as project_worktree,
        (
          select json_extract(pp.data, '$.text')
          from part pp
          join message mm on mm.id = pp.message_id
          where pp.session_id = s.id
            and json_extract(pp.data, '$.type') = 'text'
            and coalesce(json_extract(pp.data, '$.synthetic'), 0) = 0
            and coalesce(json_extract(pp.data, '$.ignored'), 0) = 0
          order by pp.time_created desc, pp.id desc
          limit 1
        ) as preview,
        (
          select count(*)
          from message mm
          where mm.session_id = s.id
        ) as message_count,
        (
          coalesce((
            select sum(length(mm.data))
            from message mm
            where mm.session_id = s.id
          ), 0) + coalesce((
            select sum(length(pp.data))
            from part pp
            where pp.session_id = s.id
          ), 0)
        ) as history_bytes
      from session s
      left join project p on p.id = s.project_id
      where s.id = ${quoteSql(providerSessionId)}
      limit 1
    `,
  );
  return buildStoredSessionRecord(rows[0], databasePath)[0] ?? null;
}

export function archiveOpenCodeStoredSession(record: OpenCodeStoredSessionRecord): void {
  sqliteExec(
    record.databasePath,
    `
      update session
      set time_archived = ${Date.now()}
      where id = ${quoteSql(record.ref.providerSessionId)}
    `,
  );
}

export function loadOpenCodeStoredMessages(
  record: OpenCodeStoredSessionRecord,
  options: { beforeTs?: string; limit?: number } = {},
): OpenCodeMessageWithParts[] {
  const beforeMs = parseBeforeTimestamp(options.beforeTs);
  const limit = Math.max(1, options.limit ?? 1000);
  const rows = sqliteJson<OpenCodeMessageRow>(
    record.databasePath,
    `
      select id, session_id, time_created, time_updated, data
      from message
      where session_id = ${quoteSql(record.ref.providerSessionId)}
        ${beforeMs !== null ? `and time_created < ${beforeMs}` : ""}
      order by time_created desc, id desc
      limit ${limit}
    `,
  ).reverse();
  if (rows.length === 0) {
    return [];
  }
  const messageIds = rows.map((row) => quoteSql(row.id)).join(",");
  const partRows = sqliteJson<OpenCodePartRow>(
    record.databasePath,
    `
      select id, session_id, message_id, data
      from part
      where message_id in (${messageIds})
      order by message_id asc, id asc
    `,
  );
  const partsByMessage = new Map<string, OpenCodePart[]>();
  for (const row of partRows) {
    const part = buildPart(row);
    if (!part) {
      continue;
    }
    const current = partsByMessage.get(row.message_id) ?? [];
    current.push(part);
    partsByMessage.set(row.message_id, current);
  }
  return rows.flatMap((row) => {
    const info = buildMessageInfo(row);
    if (!info) {
      return [];
    }
    return [{ info, parts: partsByMessage.get(row.id) ?? [] }];
  });
}

export function getOpenCodeStoredSessionHistoryPage(params: {
  sessionId: string;
  record: OpenCodeStoredSessionRecord;
  beforeTs?: string;
  limit?: number;
}): SessionHistoryPageResponse {
  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const cwd = params.record.ref.cwd ?? process.cwd();
  const temp = services.sessionStore.createManagedSession({
    provider: "opencode",
    providerSessionId: params.record.ref.providerSessionId,
    launchSource: "web",
    cwd,
    rootDir: params.record.ref.rootDir ?? cwd,
    ...(params.record.ref.title ? { title: params.record.ref.title } : {}),
    ...(params.record.ref.preview ? { preview: params.record.ref.preview } : {}),
    capabilities: REHYDRATED_CAPABILITIES,
  });
  const messageLimit = Math.min(Math.max((params.limit ?? 1000) * 4, 100), 10_000);
  const messages = loadOpenCodeStoredMessages(params.record, {
    ...(params.beforeTs ? { beforeTs: params.beforeTs } : {}),
    limit: messageLimit,
  });
  const historyState = createOpenCodeActivityState(
    messages[0]?.info.sessionID ?? params.record.ref.providerSessionId,
  );
  let lastMessageTs: string | undefined;
  for (const message of messages) {
    const messageTs = toIso(message.info.time?.created) ?? lastMessageTs;
    if (messageTs) {
      lastMessageTs = messageTs;
    }
    for (const activity of translateOpenCodeMessage(historyState, message)) {
      applyProviderActivity(
        services,
        temp.session.id,
        {
          ...HISTORY_SOURCE,
          ...(messageTs ? { ts: messageTs } : {}),
        },
        activity,
      );
    }
  }
  if (historyState.currentTurnId) {
    for (const activity of completeOpenCodeTurn(historyState)) {
      applyProviderActivity(
        services,
        temp.session.id,
        {
          ...HISTORY_SOURCE,
          ...(lastMessageTs ? { ts: lastMessageTs } : {}),
        },
        activity,
      );
    }
  }

  const all: RahEvent[] = services.eventBus
    .list({ sessionIds: [temp.session.id] })
    .filter((event) => (params.beforeTs ? event.ts < params.beforeTs : true))
    .map((event) => ({
      ...event,
      id: `history:${event.id}`,
      seq: event.seq + 1_000_000_000,
      sessionId: params.sessionId,
    }))
    .sort((left, right) => left.ts.localeCompare(right.ts) || left.seq - right.seq);
  const limit = Math.max(1, params.limit ?? 1000);
  const start = Math.max(0, all.length - limit);
  const events = all.slice(start);
  return {
    sessionId: params.sessionId,
    events,
    ...(start > 0 && events[0] ? { nextBeforeTs: events[0].ts } : {}),
  };
}

export function createOpenCodeStoredSessionFrozenHistoryPageLoader(args: {
  sessionId: string;
  record: OpenCodeStoredSessionRecord;
}): FrozenHistoryPageLoader {
  const boundary = makeOpenCodeFrozenHistoryBoundary(args.record);
  const pageAt = (beforeTs: string | undefined, limit: number) => {
    const page = getOpenCodeStoredSessionHistoryPage({
      sessionId: args.sessionId,
      record: args.record,
      ...(beforeTs ? { beforeTs } : {}),
      limit,
    });
    const nextCursor = page.nextBeforeTs
      ? encodeOpenCodeFrozenHistoryCursor({ beforeTs: page.nextBeforeTs })
      : undefined;
    return {
      boundary,
      events: page.events,
      ...(nextCursor ? { nextCursor } : {}),
      ...(page.nextBeforeTs ? { nextBeforeTs: page.nextBeforeTs } : {}),
    };
  };

  return {
    loadInitialPage: (limit) => pageAt(undefined, limit),
    loadOlderPage: (cursor, limit, frozenBoundary) => {
      if (frozenBoundary.sourceRevision !== boundary.sourceRevision) {
        throw new Error("OpenCode frozen history boundary changed while paging.");
      }
      return pageAt(decodeOpenCodeFrozenHistoryCursor(cursor).beforeTs, limit);
    },
  };
}

export function resumeOpenCodeStoredSession(params: {
  services: RuntimeServices;
  record: OpenCodeStoredSessionRecord;
  attach?: AttachSessionRequest;
}): { sessionId: string } {
  const cwd = params.record.ref.cwd ?? process.cwd();
  const state = params.services.sessionStore.createManagedSession({
    provider: "opencode",
    providerSessionId: params.record.ref.providerSessionId,
    launchSource: "web",
    cwd,
    rootDir: params.record.ref.rootDir ?? cwd,
    ...(params.record.ref.title ? { title: params.record.ref.title } : {}),
    ...(params.record.ref.preview ? { preview: params.record.ref.preview } : {}),
    capabilities: REHYDRATED_CAPABILITIES,
  });
  params.services.sessionStore.setRuntimeState(state.session.id, "idle");
  const session = params.services.sessionStore.getSession(state.session.id)!;
  publishSessionBootstrap(params.services, state.session.id, session.session);
  if (params.attach) {
    attachRequestedClient(params.services, state.session.id, params.attach);
  }
  return { sessionId: state.session.id };
}

function publishSessionBootstrap(
  services: RuntimeServices,
  sessionId: string,
  session: ManagedSession,
): void {
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

function attachRequestedClient(
  services: RuntimeServices,
  sessionId: string,
  attach: AttachSessionRequest,
): void {
  services.sessionStore.attachClient({
    sessionId,
    clientId: attach.client.id,
    kind: attach.client.kind,
    connectionId: attach.client.connectionId,
    attachMode: attach.mode,
    focus: true,
  });
  services.eventBus.publish({
    sessionId,
    type: "session.attached",
    source: SYSTEM_SOURCE,
    payload: {
      clientId: attach.client.id,
      clientKind: attach.client.kind,
    },
  });
  if (attach.claimControl) {
    services.sessionStore.claimControl(sessionId, attach.client.id, attach.client.kind);
    services.eventBus.publish({
      sessionId,
      type: "control.claimed",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: attach.client.id,
        clientKind: attach.client.kind,
      },
    });
  }
}

function buildStoredSessionRecord(
  row: OpenCodeSessionRow | undefined,
  databasePath: string,
): OpenCodeStoredSessionRecord[] {
  if (!row?.id) {
    return [];
  }
  const cwd = normalizeDirectory(row.directory ?? undefined) ?? undefined;
  const projectRoot = normalizeDirectory(row.project_worktree ?? undefined);
  const rootDir = projectRoot && projectRoot !== "/" ? projectRoot : cwd;
  const ref: StoredSessionRef = withHistoryMeta({
    provider: "opencode",
    providerSessionId: row.id,
    source: "provider_history",
    ...(cwd ? { cwd } : {}),
    ...(rootDir ? { rootDir } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.preview ? { preview: truncateText(row.preview) } : {}),
    ...(toIso(row.time_created) ? { createdAt: toIso(row.time_created)! } : {}),
    ...(toIso(row.time_updated) ? { updatedAt: toIso(row.time_updated)! } : {}),
    ...(toIso(row.time_updated) ? { lastUsedAt: toIso(row.time_updated)! } : {}),
  }, {
    ...(typeof row.history_bytes === "number" ? { bytes: row.history_bytes } : {}),
    ...(typeof row.message_count === "number" ? { messages: row.message_count } : {}),
  });
  return [{ ref, databasePath }];
}

function buildMessageInfo(row: OpenCodeMessageRow): OpenCodeMessageInfo | null {
  const data = parseJsonRecord(row.data);
  const role = data?.role === "assistant" ? "assistant" : data?.role === "user" ? "user" : null;
  if (!data || !role) {
    return null;
  }
  const time = readRecord(data.time);
  return {
    ...data,
    id: row.id,
    sessionID: row.session_id,
    role,
    ...(typeof data.parentID === "string" ? { parentID: data.parentID } : {}),
    ...(typeof data.agent === "string" ? { agent: data.agent } : {}),
    ...(typeof data.providerID === "string" ? { providerID: data.providerID } : {}),
    ...(typeof data.modelID === "string" ? { modelID: data.modelID } : {}),
    ...(typeof data.finish === "string" ? { finish: data.finish } : {}),
    ...(data.error !== undefined ? { error: data.error } : {}),
    time: {
      ...(typeof time?.created === "number" ? { created: time.created } : {}),
      ...(typeof time?.completed === "number" ? { completed: time.completed } : {}),
    },
  } as OpenCodeMessageInfo;
}

function buildPart(row: OpenCodePartRow): OpenCodePart | null {
  const data = parseJsonRecord(row.data);
  if (!data || typeof data.type !== "string") {
    return null;
  }
  return {
    ...data,
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id,
    type: data.type,
  } as OpenCodePart;
}

function sqliteJson<T>(databasePath: string, sql: string): T[] {
  if (!existsSync(databasePath)) {
    return [];
  }
  try {
    const output = execFileSync("sqlite3", ["-json", databasePath, sql], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
    if (!output) {
      return [];
    }
    const parsed = JSON.parse(output) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function sqliteExec(databasePath: string, sql: string): void {
  if (!existsSync(databasePath)) {
    throw new Error(`OpenCode database not found: ${databasePath}`);
  }
  execFileSync("sqlite3", [databasePath, sql], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

function quoteSql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function parseBeforeTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return readRecord(parsed);
  } catch {
    return null;
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toIso(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return new Date(value).toISOString();
}

function truncateText(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}
