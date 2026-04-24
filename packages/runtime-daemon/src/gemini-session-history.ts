import { statSync } from "node:fs";
import type {
  AttachSessionRequest,
  ManagedSession,
  SessionHistoryPageResponse,
} from "@rah/runtime-protocol";
import type {
  FrozenHistoryBoundary,
  FrozenHistoryPage,
  FrozenHistoryPageLoader,
} from "./history-snapshots";
import type { RuntimeServices } from "./provider-adapter";
import { loadCachedGeminiHistoryWindow } from "./gemini-history-cache";
import { REHYDRATED_CAPABILITIES } from "./gemini-session-types";
import type { GeminiStoredSessionRecord } from "./gemini-session-types";
import {
  ensureGeminiHistoryCacheRevision,
  materializeGeminiHistoryEventsFromRecord,
  rebindGeminiHistoryWindowEvents,
} from "./gemini-history-cache-utils";

const SYSTEM_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

type GeminiFrozenHistoryCursor = {
  offset: number;
};

function encodeGeminiFrozenHistoryCursor(cursor: GeminiFrozenHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeGeminiFrozenHistoryCursor(cursor: string): GeminiFrozenHistoryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      offset?: unknown;
    };
    if (
      typeof parsed.offset !== "number" ||
      !Number.isInteger(parsed.offset) ||
      parsed.offset < 0
    ) {
      throw new Error("Invalid Gemini frozen history cursor.");
    }
    return { offset: parsed.offset };
  } catch {
    throw new Error("Invalid Gemini frozen history cursor.");
  }
}

function makeGeminiFrozenHistoryBoundary(
  filePath: string,
  fileSize: number,
  mtimeMs: number,
): FrozenHistoryBoundary {
  return {
    kind: "frozen",
    sourceRevision: JSON.stringify({
      provider: "gemini",
      filePath,
      fileSize,
      mtimeMs,
    }),
  };
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

export function resumeGeminiStoredSession(params: {
  services: RuntimeServices;
  record: GeminiStoredSessionRecord;
  cwd?: string;
  attach?: AttachSessionRequest;
}): { sessionId: string } {
  const cwd = params.cwd ?? params.record.ref.cwd ?? process.cwd();
  const state = params.services.sessionStore.createManagedSession({
    provider: "gemini",
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

export function getGeminiStoredSessionHistoryPage(params: {
  sessionId: string;
  record: GeminiStoredSessionRecord;
  beforeTs?: string;
  limit?: number;
}): SessionHistoryPageResponse {
  const all = materializeGeminiHistoryEventsFromRecord({
    sessionId: params.sessionId,
    record: params.record,
  })
    .filter((event) => (params.beforeTs ? event.ts < params.beforeTs : true))
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

export function createGeminiStoredSessionFrozenHistoryPageLoader(args: {
  sessionId: string;
  record: GeminiStoredSessionRecord;
}): FrozenHistoryPageLoader {
  const stats = statSync(args.record.filePath);
  const boundary = makeGeminiFrozenHistoryBoundary(
    args.record.filePath,
    stats.size,
    stats.mtimeMs,
  );
  let cachedTotalEvents: number | undefined;

  const pageAt = (offset: number, limit: number): FrozenHistoryPage => {
    const safeLimit = Math.max(1, limit);
    const manifest = ensureGeminiHistoryCacheRevision({
      sessionId: args.sessionId,
      record: args.record,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    });
    cachedTotalEvents = manifest.totalEvents;
    const boundedOffset = Math.max(0, Math.min(offset, cachedTotalEvents));
    const start = Math.max(0, boundedOffset - safeLimit);
    const window = loadCachedGeminiHistoryWindow({
      filePath: args.record.filePath,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      startOffset: start,
      endOffset: boundedOffset,
    });
    if (!window) {
      throw new Error("Gemini history cache became unavailable while paging.");
    }
    const pageEvents = rebindGeminiHistoryWindowEvents({
      sessionId: args.sessionId,
      startOffset: start,
      events: window.events,
    });
    const nextCursor = start > 0 ? encodeGeminiFrozenHistoryCursor({ offset: start }) : undefined;
    return {
      boundary,
      events: pageEvents,
      ...(nextCursor ? { nextCursor } : {}),
      ...(pageEvents[0] ? { nextBeforeTs: pageEvents[0].ts } : {}),
    };
  };

  return {
    loadInitialPage: (limit) => pageAt(Number.MAX_SAFE_INTEGER, limit),
    loadOlderPage: (cursor, limit, frozenBoundary) => {
      if (frozenBoundary.sourceRevision !== boundary.sourceRevision) {
        throw new Error("Gemini frozen history boundary changed while paging.");
      }
      const decoded = decodeGeminiFrozenHistoryCursor(cursor);
      return pageAt(decoded.offset, limit);
    },
  };
}
