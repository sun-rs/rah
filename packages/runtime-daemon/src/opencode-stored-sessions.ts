import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AttachSessionRequest,
  ManagedSession,
  RahEvent,
  ConversationEvidencePage,
  ConversationTurnDirectoryResponse,
  ConversationTurnDirectoryStatus,
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
  isOpenCodeInternalInitiatorText,
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
import { runtimeDescriptorForStoredHistory } from "./session-runtime-descriptor";
import { providerBinaryArgv } from "./provider-binary-utils";

export interface OpenCodeStoredSessionRecord {
  ref: StoredSessionRef;
  databasePath: string;
}

export class OpenCodeSqliteReadError extends Error {
  constructor(
    readonly databasePath: string,
    readonly cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to read OpenCode database ${databasePath}: ${detail}`);
    this.name = "OpenCodeSqliteReadError";
  }
}

const REHYDRATED_CAPABILITIES = {
  liveAttach: false,
  structuredTimeline: true,
  nativeTui: false,
  rawPtyInput: false,
  chatMirror: false,
  structuredControl: false,
  livePermissions: false,
  contextUsage: false,
  resumeByProvider: true,
  listProviderSessions: true,
  steerInput: false,
  queuedInput: false,
  actions: {
    info: true,
    stop: false,
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

type OpenCodeTurnDirectoryRow = {
  id: string;
  time_created: number | null;
  user_preview: string | null;
  assistant_preview: string | null;
  assistant_created: number | null;
  assistant_completed: number | null;
  assistant_finish: string | null;
  assistant_error_name: string | null;
  assistant_error_message: string | null;
};

type OpenCodeFrozenHistoryCursor = {
  beforeTs: string;
  beforeMessageId?: string;
};

function encodeOpenCodeFrozenHistoryCursor(cursor: OpenCodeFrozenHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeOpenCodeFrozenHistoryCursor(cursor: string): OpenCodeFrozenHistoryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      beforeTs?: unknown;
      beforeMessageId?: unknown;
    };
    if (
      typeof parsed.beforeTs !== "string" ||
      !parsed.beforeTs ||
      !Number.isFinite(Date.parse(parsed.beforeTs)) ||
      (parsed.beforeMessageId !== undefined &&
        (typeof parsed.beforeMessageId !== "string" || !parsed.beforeMessageId))
    ) {
      throw new Error("Invalid OpenCode frozen history cursor.");
    }
    return {
      beforeTs: parsed.beforeTs,
      ...(typeof parsed.beforeMessageId === "string"
        ? { beforeMessageId: parsed.beforeMessageId }
        : {}),
    };
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
  throwOnReadError?: boolean;
} = {}): OpenCodeStoredSessionRecord[] {
  const databasePath = resolveOpenCodeDatabasePath(options.dataDir);
  const limitClause = options.limit === undefined
    ? ""
    : `limit ${Math.max(1, options.limit)}`;
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
        coalesce(
          (
            select json_extract(pp.data, '$.text')
            from part pp
            join message mm on mm.id = pp.message_id
            where pp.session_id = s.id
              and json_extract(mm.data, '$.role') = 'assistant'
              and json_extract(pp.data, '$.type') = 'text'
              and coalesce(json_extract(pp.data, '$.synthetic'), 0) = 0
              and coalesce(json_extract(pp.data, '$.ignored'), 0) = 0
            order by pp.time_created asc, pp.id asc
            limit 1
          ),
          (
            select json_extract(pp.data, '$.text')
            from part pp
            join message mm on mm.id = pp.message_id
            where pp.session_id = s.id
              and json_extract(mm.data, '$.role') = 'user'
              and json_extract(pp.data, '$.type') = 'text'
              and coalesce(json_extract(pp.data, '$.synthetic'), 0) = 0
              and coalesce(json_extract(pp.data, '$.ignored'), 0) = 0
            order by pp.time_created asc, pp.id asc
            limit 1
          )
        ) as preview,
        (
          select count(*)
          from message mm
          where mm.session_id = s.id
        ) as message_count,
        (
          coalesce((
            select sum(length(cast(mm.data as blob)))
            from message mm
            where mm.session_id = s.id
          ), 0) + coalesce((
            select sum(length(cast(pp.data as blob)))
            from part pp
            where pp.session_id = s.id
          ), 0)
        ) as history_bytes
      from session s
      left join project p on p.id = s.project_id
      where s.parent_id is null
      order by (s.time_archived is not null) asc, s.time_updated desc, s.id desc
      ${limitClause}
    `,
    { throwOnReadError: options.throwOnReadError === true },
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
        coalesce(
          (
            select json_extract(pp.data, '$.text')
            from part pp
            join message mm on mm.id = pp.message_id
            where pp.session_id = s.id
              and json_extract(mm.data, '$.role') = 'assistant'
              and json_extract(pp.data, '$.type') = 'text'
              and coalesce(json_extract(pp.data, '$.synthetic'), 0) = 0
              and coalesce(json_extract(pp.data, '$.ignored'), 0) = 0
            order by pp.time_created asc, pp.id asc
            limit 1
          ),
          (
            select json_extract(pp.data, '$.text')
            from part pp
            join message mm on mm.id = pp.message_id
            where pp.session_id = s.id
              and json_extract(mm.data, '$.role') = 'user'
              and json_extract(pp.data, '$.type') = 'text'
              and coalesce(json_extract(pp.data, '$.synthetic'), 0) = 0
              and coalesce(json_extract(pp.data, '$.ignored'), 0) = 0
            order by pp.time_created asc, pp.id asc
            limit 1
          )
        ) as preview,
        (
          select count(*)
          from message mm
          where mm.session_id = s.id
        ) as message_count,
        (
          coalesce((
            select sum(length(cast(mm.data as blob)))
            from message mm
            where mm.session_id = s.id
          ), 0) + coalesce((
            select sum(length(cast(pp.data as blob)))
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

export function restoreOpenCodeStoredSession(record: OpenCodeStoredSessionRecord): void {
  sqliteExec(
    record.databasePath,
    `
      update session
      set time_archived = null
      where id = ${quoteSql(record.ref.providerSessionId)}
    `,
  );
  const verification = sqliteJson<{ time_archived: number | null }>(
    record.databasePath,
    `
      select time_archived
      from session
      where id = ${quoteSql(record.ref.providerSessionId)}
      limit 1
    `,
  )[0];
  if (!verification || verification.time_archived !== null) {
    throw new Error(
      `OpenCode could not restore archived session ${record.ref.providerSessionId}.`,
    );
  }
}

/**
 * Permanently removes an OpenCode session through OpenCode's public CLI. RAH
 * deliberately does not emulate deletion by setting time_archived: archive
 * and delete are distinct product operations, and the provider owns recursive
 * cleanup of child sessions and related records.
 */
export function deleteOpenCodeStoredSession(record: OpenCodeStoredSessionRecord): void {
  const dataDir = path.dirname(record.databasePath);
  if (path.basename(dataDir) !== "opencode") {
    throw new Error(
      `OpenCode session deletion requires the standard XDG database layout: ${record.databasePath}`,
    );
  }
  const xdgDataHome = path.dirname(dataDir);
  const binary = process.env.RAH_OPENCODE_BINARY?.trim() || "opencode";
  const [command, ...prefixArgs] = providerBinaryArgv(binary);
  if (!command) {
    throw new Error("OpenCode session deletion requires a provider command.");
  }
  try {
    execFileSync(
      command,
      [...prefixArgs, "session", "delete", record.ref.providerSessionId],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          XDG_DATA_HOME: xdgDataHome,
        },
      },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `OpenCode could not permanently delete session ${record.ref.providerSessionId}: ${detail}`,
    );
  }

  const remaining = sqliteJson<{ id: string }>(
    record.databasePath,
    `select id from session where id = ${quoteSql(record.ref.providerSessionId)} limit 1`,
    { throwOnReadError: true },
  );
  if (remaining.length > 0) {
    throw new Error(
      `OpenCode reported success but session ${record.ref.providerSessionId} still exists.`,
    );
  }
}

export function loadOpenCodeStoredMessages(
  record: OpenCodeStoredSessionRecord,
  options: {
    beforeTs?: string;
    beforeMessageId?: string;
    limit?: number;
    summary?: boolean;
  } = {},
): OpenCodeMessageWithParts[] {
  const beforeMs = parseBeforeTimestamp(options.beforeTs);
  const limit = Math.max(1, options.limit ?? 1000);
  const rows = sqliteJson<OpenCodeMessageRow>(
    record.databasePath,
    `
      select id, session_id, time_created, time_updated,
        json_remove(data, '$.summary') as data
      from message
      where session_id = ${quoteSql(record.ref.providerSessionId)}
        ${openCodeMessageBoundarySql(beforeMs, options.beforeMessageId)}
      order by time_created desc, id desc
      limit ${limit}
    `,
  ).reverse();
  return loadOpenCodeMessagesForRows(record, rows, {
    summary: options.summary === true,
  });
}

type OpenCodeStoredTurnMessagesPage = {
  messages: OpenCodeMessageWithParts[];
  nextCursor?: string;
  nextBeforeTs?: string;
};

function loadOpenCodeStoredTurnMessages(params: {
  record: OpenCodeStoredSessionRecord;
  cursor?: string;
  limit: number;
  summary?: boolean;
}): OpenCodeStoredTurnMessagesPage {
  const cursor = params.cursor ? decodeOpenCodeFrozenHistoryCursor(params.cursor) : undefined;
  const beforeMs = parseBeforeTimestamp(cursor?.beforeTs);
  const rootRows = sqliteJson<OpenCodeMessageRow>(
    params.record.databasePath,
    `
      select id, session_id, time_created, time_updated,
        json_remove(data, '$.summary') as data
      from message
      where session_id = ${quoteSql(params.record.ref.providerSessionId)}
        and json_extract(data, '$.role') = 'user'
        ${openCodeMessageBoundarySql(beforeMs, cursor?.beforeMessageId)}
      order by time_created desc, id desc
      limit ${params.limit + 1}
    `,
  );
  const selectedRoots = rootRows.slice(0, params.limit);
  if (selectedRoots.length === 0) {
    return { messages: [] };
  }

  const rootIds = selectedRoots.map((row) => quoteSql(row.id)).join(",");
  // OpenCode's message protocol defines a turn as one user root plus every
  // assistant message whose parentID is that root. Query that contract
  // directly so a small page never scans or materializes unrelated turns.
  const rows = sqliteJson<OpenCodeMessageRow>(
    params.record.databasePath,
    `
      select id, session_id, time_created, time_updated,
        json_remove(data, '$.summary') as data
      from message
      where session_id = ${quoteSql(params.record.ref.providerSessionId)}
        and (
          id in (${rootIds})
          or json_extract(data, '$.parentID') in (${rootIds})
        )
      order by time_created asc, id asc
    `,
  );
  const hasOlder = rootRows.length > params.limit;
  const earliestRoot = selectedRoots.at(-1);
  const nextBeforeTs = hasOlder ? toIso(earliestRoot?.time_created) ?? undefined : undefined;
  const nextCursor =
    hasOlder && nextBeforeTs && earliestRoot
      ? encodeOpenCodeFrozenHistoryCursor({
          beforeTs: nextBeforeTs,
          beforeMessageId: earliestRoot.id,
        })
      : undefined;
  return {
    messages: loadOpenCodeMessagesForRows(params.record, rows, {
      summary: params.summary === true,
    }),
    ...(nextCursor ? { nextCursor } : {}),
    ...(nextBeforeTs ? { nextBeforeTs } : {}),
  };
}

function loadOpenCodeMessagesForRows(
  record: OpenCodeStoredSessionRecord,
  rows: readonly OpenCodeMessageRow[],
  options: { summary?: boolean } = {},
): OpenCodeMessageWithParts[] {
  if (rows.length === 0) {
    return [];
  }
  const messageIds = rows.map((row) => quoteSql(row.id)).join(",");
  const partDataSql = options.summary
    ? `
        case
          when json_extract(data, '$.type') = 'tool'
            and json_extract(data, '$.tool') not like 'rah_council_%'
            and json_extract(data, '$.tool') not like 'mcp__rah_council__%'
            and json_extract(data, '$.tool') not in (
              'channel_join', 'channel_post', 'channel_wait_new', 'channel_history',
              'channel_state', 'channel_peek_inbox', 'channel_set_status',
              'channel_claim_file', 'channel_release_file', 'channel_list_claims',
              'channel_send_control', 'channel_peek_control'
            )
          then json_remove(
            data,
            '$.state.input',
            '$.state.output',
            '$.state.metadata.output',
            '$.state.metadata.diagnostics',
            '$.state.metadata.files',
            '$.state.metadata.filediff',
            '$.state.metadata.diff',
            '$.state.metadata.preview',
            '$.state.metadata.todos'
          )
          else data
        end
      `
    : "data";
  const partFilterSql = options.summary
    ? `
        and (
          json_extract(data, '$.type') not in ('reasoning', 'tool')
          or (
            json_extract(data, '$.type') = 'tool'
            and (
              json_extract(data, '$.tool') like 'rah_council_%'
              or json_extract(data, '$.tool') like 'mcp__rah_council__%'
              or json_extract(data, '$.tool') in (
                'channel_join', 'channel_post', 'channel_wait_new', 'channel_history',
                'channel_state', 'channel_peek_inbox', 'channel_set_status',
                'channel_claim_file', 'channel_release_file', 'channel_list_claims',
                'channel_send_control', 'channel_peek_control'
              )
            )
          )
        )
      `
    : "";
  const partRows = sqliteJson<OpenCodePartRow>(
    record.databasePath,
    `
      select id, session_id, message_id, ${partDataSql} as data
      from part
      where session_id = ${quoteSql(record.ref.providerSessionId)}
        and message_id in (${messageIds})
        ${partFilterSql}
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
}): ConversationEvidencePage {
  const messageLimit = Math.min(Math.max((params.limit ?? 1000) * 4, 100), 10_000);
  let fetchLimit = Math.min(messageLimit + 1, 10_000);
  let fetchedMessages = loadOpenCodeStoredMessages(params.record, {
    ...(params.beforeTs ? { beforeTs: params.beforeTs } : {}),
    limit: fetchLimit,
  });
  // A tool-heavy turn can contain many assistant messages after its user root.
  // Grow the local SQLite window until that semantic boundary is present. This
  // work stays on the daemon; the browser still receives a bounded turn page.
  while (
    fetchedMessages.length === fetchLimit &&
    !fetchedMessages.some((message) => message.info.role === "user") &&
    fetchLimit < 10_000
  ) {
    fetchLimit = Math.min(fetchLimit * 2, 10_000);
    fetchedMessages = loadOpenCodeStoredMessages(params.record, {
      ...(params.beforeTs ? { beforeTs: params.beforeTs } : {}),
      limit: fetchLimit,
    });
  }
  const hasEarlierMessages = fetchedMessages.length > messageLimit;
  const boundedMessages = fetchedMessages.slice(-messageLimit);
  const firstUserIndex = boundedMessages.findIndex((message) => message.info.role === "user");
  const messages = firstUserIndex > 0 ? boundedMessages.slice(firstUserIndex) : boundedMessages;
  const droppedLeadingContinuation = firstUserIndex > 0;
  const all = materializeOpenCodeStoredMessages({
    sessionId: params.sessionId,
    record: params.record,
    messages,
    finalizeTrailingTurn: true,
  })
    .filter((event) => (params.beforeTs ? event.ts < params.beforeTs : true))
    .sort((left, right) => left.ts.localeCompare(right.ts) || left.seq - right.seq);
  const limit = Math.max(1, params.limit ?? 1000);
  const naiveStart = Math.max(0, all.length - limit);
  const firstIncludedTurnId = all
    .slice(naiveStart)
    .find((event) => event.turnId !== undefined)?.turnId;
  const semanticStart = firstIncludedTurnId
    ? all.findIndex((event) => event.turnId === firstIncludedTurnId)
    : naiveStart;
  const start = semanticStart >= 0 ? Math.min(naiveStart, semanticStart) : naiveStart;
  const events = all.slice(start);
  const hasOlder = start > 0 || hasEarlierMessages || droppedLeadingContinuation;
  return {
    sessionId: params.sessionId,
    events,
    ...(hasOlder && events[0] ? { nextBeforeTs: events[0].ts } : {}),
  };
}

export function getOpenCodeStoredSessionTurnHistoryPage(params: {
  sessionId: string;
  record: OpenCodeStoredSessionRecord;
  cursor?: string;
  limit?: number;
  finalizeTrailingTurn?: boolean;
}): ConversationEvidencePage {
  const page = loadOpenCodeStoredTurnMessages({
    record: params.record,
    ...(params.cursor ? { cursor: params.cursor } : {}),
    limit: Math.max(1, Math.min(params.limit ?? 20, 100)),
    summary: true,
  });
  return {
    sessionId: params.sessionId,
    events: materializeOpenCodeStoredMessages({
      sessionId: params.sessionId,
      record: params.record,
      messages: page.messages,
      finalizeTrailingTurn: params.finalizeTrailingTurn !== false,
    }),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    ...(page.nextBeforeTs ? { nextBeforeTs: page.nextBeforeTs } : {}),
  };
}

export function getOpenCodeStoredSessionTurnDetail(params: {
  sessionId: string;
  record: OpenCodeStoredSessionRecord;
  providerTurnId: string;
}): ConversationEvidencePage | undefined {
  const rootMessageId = openCodeRootMessageIdFromProviderTurnId(params.providerTurnId);
  if (!rootMessageId) {
    return undefined;
  }
  const rootRows = sqliteJson<OpenCodeMessageRow>(
    params.record.databasePath,
    `
      select id, session_id, time_created, time_updated,
        json_remove(data, '$.summary') as data
      from message
      where session_id = ${quoteSql(params.record.ref.providerSessionId)}
        and id = ${quoteSql(rootMessageId)}
        and json_extract(data, '$.role') = 'user'
      limit 1
    `,
  );
  if (rootRows.length === 0) {
    return undefined;
  }
  const rows = sqliteJson<OpenCodeMessageRow>(
    params.record.databasePath,
    `
      select id, session_id, time_created, time_updated,
        json_remove(data, '$.summary') as data
      from message
      where session_id = ${quoteSql(params.record.ref.providerSessionId)}
        and (
          id = ${quoteSql(rootMessageId)}
          or json_extract(data, '$.parentID') = ${quoteSql(rootMessageId)}
        )
      order by time_created asc, id asc
    `,
  );
  return {
    sessionId: params.sessionId,
    events: materializeOpenCodeStoredMessages({
      sessionId: params.sessionId,
      record: params.record,
      messages: loadOpenCodeMessagesForRows(params.record, rows),
      finalizeTrailingTurn: true,
    }),
  };
}

export function getOpenCodeStoredSessionTurnDirectory(params: {
  sessionId: string;
  record: OpenCodeStoredSessionRecord;
}): ConversationTurnDirectoryResponse {
  const providerSessionId = quoteSql(params.record.ref.providerSessionId);
  const rows = sqliteJson<OpenCodeTurnDirectoryRow>(
    params.record.databasePath,
    `
      with roots as (
        select
          m.id,
          m.time_created,
          (
            select json_extract(p.data, '$.text')
            from part p
            where p.message_id = m.id
              and json_extract(p.data, '$.type') = 'text'
              and coalesce(json_extract(p.data, '$.synthetic'), 0) = 0
              and coalesce(json_extract(p.data, '$.ignored'), 0) = 0
            order by p.id asc
            limit 1
          ) as user_preview
        from message m
        where m.session_id = ${providerSessionId}
          and json_extract(m.data, '$.role') = 'user'
      ),
      latest_assistant as (
        select
          r.id as root_id,
          (
            select a.id
            from message a
            where a.session_id = ${providerSessionId}
              and json_extract(a.data, '$.role') = 'assistant'
              and json_extract(a.data, '$.parentID') = r.id
            order by a.time_created desc, a.id desc
            limit 1
          ) as assistant_id
        from roots r
      )
      select
        r.id,
        r.time_created,
        r.user_preview,
        (
          select json_extract(p.data, '$.text')
          from part p
          join message candidate on candidate.id = p.message_id
          where candidate.session_id = ${providerSessionId}
            and json_extract(candidate.data, '$.role') = 'assistant'
            and json_extract(candidate.data, '$.parentID') = r.id
            and json_extract(p.data, '$.type') = 'text'
            and coalesce(json_extract(p.data, '$.synthetic'), 0) = 0
            and coalesce(json_extract(p.data, '$.ignored'), 0) = 0
          order by candidate.time_created desc, p.id desc
          limit 1
        ) as assistant_preview,
        a.time_created as assistant_created,
        json_extract(a.data, '$.time.completed') as assistant_completed,
        json_extract(a.data, '$.finish') as assistant_finish,
        json_extract(a.data, '$.error.name') as assistant_error_name,
        json_extract(a.data, '$.error.data.message') as assistant_error_message
      from roots r
      left join latest_assistant la on la.root_id = r.id
      left join message a on a.id = la.assistant_id
      order by r.time_created asc, r.id asc
    `,
  ).filter((row) => {
    const preview = row.user_preview?.trim();
    return Boolean(preview) && !isOpenCodeInternalInitiatorText(preview!);
  });
  const drafts = rows.flatMap((row, index) => {
    const startedAt = toIso(row.time_created);
    const userPreview = row.user_preview?.trim();
    if (!startedAt || !userPreview) {
      return [];
    }
    const completedAt = toIso(row.assistant_completed);
    const status = openCodeDirectoryStatus(row, index < rows.length - 1);
    const durationMs =
      completedAt && typeof row.time_created === "number"
        ? Math.max(0, Date.parse(completedAt) - row.time_created)
        : undefined;
    return [{
      id: `opencode:${row.id}`,
      ordinal: index,
      userPreview: truncateText(userPreview),
      ...(row.assistant_preview?.trim()
        ? { assistantPreview: truncateText(row.assistant_preview) }
        : {}),
      startedAt,
      ...(completedAt ? { completedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      status,
    }];
  });
  const revision = createHash("sha256")
    .update(params.record.ref.updatedAt ?? "")
    .update(JSON.stringify(drafts.map((item) => [item.id, item.status, item.completedAt ?? null])))
    .digest("base64url")
    .slice(0, 22);
  return {
    sessionId: params.sessionId,
    revision,
    items: drafts,
    complete: true,
    ...(params.record.ref.historyMeta?.bytes !== undefined
      ? { sourceBytes: params.record.ref.historyMeta.bytes }
      : {}),
    generatedAt: new Date().toISOString(),
  };
}

function openCodeDirectoryStatus(
  row: OpenCodeTurnDirectoryRow,
  hasLaterTurn: boolean,
): ConversationTurnDirectoryStatus {
  const errorName = row.assistant_error_name?.trim() ?? "";
  const errorMessage = row.assistant_error_message?.trim() ?? "";
  if (
    errorName === "MessageAbortedError" ||
    errorName === "AbortError" ||
    errorMessage === "Aborted" ||
    /operation was aborted/i.test(errorMessage)
  ) {
    return "interrupted";
  }
  if (errorName || errorMessage) {
    return "failed";
  }
  if (
    row.assistant_completed !== null &&
    row.assistant_finish !== "tool-calls"
  ) {
    return "completed";
  }
  return hasLaterTurn ? "interrupted" : "in_progress";
}

function openCodeRootMessageIdFromProviderTurnId(providerTurnId: string): string | null {
  const prefix = "opencode:";
  if (!providerTurnId.startsWith(prefix)) {
    return null;
  }
  const messageId = providerTurnId.slice(prefix.length).trim();
  return messageId || null;
}

function materializeOpenCodeStoredMessages(params: {
  sessionId: string;
  record: OpenCodeStoredSessionRecord;
  messages: readonly OpenCodeMessageWithParts[];
  finalizeTrailingTurn: boolean;
}): RahEvent[] {
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
    runtime: runtimeDescriptorForStoredHistory(),
    capabilities: REHYDRATED_CAPABILITIES,
  });
  const historyState = createOpenCodeActivityState(
    params.messages[0]?.info.sessionID ?? params.record.ref.providerSessionId,
    { origin: "history" },
  );
  let lastMessageTs: string | undefined;
  for (const message of params.messages) {
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
  if (params.finalizeTrailingTurn && historyState.currentTurnId) {
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
  return services.eventBus
    .list({ sessionIds: [temp.session.id] })
    .map((event) => ({
      ...event,
      id: `history:${event.id}`,
      seq: event.seq + 1_000_000_000,
      sessionId: params.sessionId,
    }))
    .sort((left, right) => left.ts.localeCompare(right.ts) || left.seq - right.seq);
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
    boundary,
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
    runtime: runtimeDescriptorForStoredHistory(),
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
    removalDisposition: "permanent",
    ...(cwd ? { cwd } : {}),
    ...(rootDir ? { rootDir } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.preview ? { preview: truncateText(row.preview) } : {}),
    ...(toIso(row.time_created) ? { createdAt: toIso(row.time_created)! } : {}),
    ...(toIso(row.time_updated) ? { updatedAt: toIso(row.time_updated)! } : {}),
    ...(toIso(row.time_updated) ? { lastUsedAt: toIso(row.time_updated)! } : {}),
    ...(toIso(row.time_archived)
      ? {
          providerState: {
            archived: true,
            archivedAt: toIso(row.time_archived)!,
          },
        }
      : {}),
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
    ...(typeof data.variant === "string" ? { variant: data.variant } : {}),
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

function sqliteJson<T>(
  databasePath: string,
  sql: string,
  options: { throwOnReadError?: boolean } = {},
): T[] {
  if (!existsSync(databasePath)) {
    return [];
  }
  try {
    const output = execFileSync("sqlite3", ["-json", databasePath, sql], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!output) {
      return [];
    }
    const parsed = JSON.parse(output) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (error) {
    if (options.throwOnReadError === true) {
      throw new OpenCodeSqliteReadError(databasePath, error);
    }
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

function openCodeMessageBoundarySql(
  beforeMs: number | null,
  beforeMessageId: string | undefined,
): string {
  if (beforeMs === null) {
    return "";
  }
  if (!beforeMessageId) {
    return `and time_created < ${beforeMs}`;
  }
  return `and (time_created < ${beforeMs} or (time_created = ${beforeMs} and id < ${quoteSql(beforeMessageId)}))`;
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
