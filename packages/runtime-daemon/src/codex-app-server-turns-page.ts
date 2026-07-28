import type { RahEvent, ConversationEvidencePage } from "@rah/runtime-protocol";
import {
  createCodexAppServerTranslationState,
  translateCodexAppServerThreadSnapshot,
} from "./codex-app-server-activity";
import { approximateJsonByteLength } from "./bounded-json-size";
import { EventBus } from "./event-bus";
import { applyProviderActivity } from "./provider-activity";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";

export interface CodexAppServerTurnsPage {
  data: unknown[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
  sourceRevision?: string;
}

export interface CodexAppServerItemsPage {
  data: unknown[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
}

export function reconcileCodexTrailingTurnLiveness(
  page: CodexAppServerTurnsPage,
  options: {
    latestPage: boolean;
    sourceSettled: boolean;
    fallbackCompletedAtMs?: number;
  },
): CodexAppServerTurnsPage {
  if (!options.latestPage || page.data.length === 0) {
    return page;
  }
  const trailing = page.data[0];
  if (!trailing || typeof trailing !== "object" || Array.isArray(trailing)) {
    return page;
  }
  const record = trailing as Record<string, unknown>;
  if (record.status !== "interrupted") {
    return page;
  }
  const completedAt = record.completedAt ?? record.completed_at;
  const durationMs = record.durationMs ?? record.duration_ms;
  if (
    (typeof completedAt === "number" && Number.isFinite(completedAt)) ||
    (typeof durationMs === "number" && Number.isFinite(durationMs))
  ) {
    return page;
  }

  const nextTurn: Record<string, unknown> = { ...record };
  if (!options.sourceSettled) {
    nextTurn.status = "inProgress";
  } else if (
    options.fallbackCompletedAtMs !== undefined &&
    Number.isFinite(options.fallbackCompletedAtMs)
  ) {
    const startedAt =
      typeof record.startedAt === "number"
        ? record.startedAt
        : typeof record.started_at === "number"
          ? record.started_at
          : undefined;
    const completedAtSeconds = Math.max(
      startedAt ?? 0,
      options.fallbackCompletedAtMs / 1_000,
    );
    nextTurn.completedAt = completedAtSeconds;
    if (startedAt !== undefined && Number.isFinite(startedAt)) {
      nextTurn.durationMs = Math.max(0, (completedAtSeconds - startedAt) * 1_000);
    }
  }
  return {
    ...page,
    data: [nextTurn, ...page.data.slice(1)],
  };
}

export function materializeCodexAppServerTurnsPage(args: {
  sessionId: string;
  providerSessionId: string;
  page: CodexAppServerTurnsPage;
  includeRaw?: boolean;
}): ConversationEvidencePage {
  const turnProcessDetailsAvailable = Object.fromEntries(
    args.page.data.flatMap((turn) => {
      if (!turn || typeof turn !== "object" || Array.isArray(turn)) {
        return [];
      }
      const record = turn as Record<string, unknown>;
      return typeof record.id === "string" &&
        typeof record.processDetailsAvailable === "boolean"
        ? [[record.id, record.processDetailsAvailable] as const]
        : [];
    }),
  );
  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const temp = services.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: args.providerSessionId,
    launchSource: "web",
    cwd: process.cwd(),
    rootDir: process.cwd(),
  });
  const translated = translateCodexAppServerThreadSnapshot(
    {
      id: args.providerSessionId,
      // Native pages are descending. The canonical ledger is chronological.
      turns: [...args.page.data].reverse(),
    },
    createCodexAppServerTranslationState(),
    args.page,
  );
  for (const item of translated) {
    applyProviderActivity(
      services,
      temp.session.id,
      {
        provider: "codex",
        channel: item.channel ?? "structured_persisted",
        // This is provider-owned persisted history, not a rollout heuristic.
        authority: item.authority ?? "authoritative",
        ...(item.ts ? { ts: item.ts } : {}),
        ...(item.raw !== undefined ? { raw: item.raw } : {}),
      },
      item.activity,
    );
  }
  const events = services.eventBus
    .list({ sessionIds: [temp.session.id] })
    .map((event, index) => {
      const { raw, ...canonicalEvent } = event;
      return {
        ...(args.includeRaw ? event : canonicalEvent),
        id: `codex-turn-page:${args.providerSessionId}:${index}`,
        seq: index + 1,
        sessionId: args.sessionId,
        ...(args.includeRaw && raw !== undefined ? { raw } : {}),
      } as RahEvent;
    });
  const response: ConversationEvidencePage = {
    sessionId: args.sessionId,
    events,
    detailMode: "summary",
    ...(args.page.sourceRevision
      ? { sourceRevision: args.page.sourceRevision }
      : {}),
    ...(Object.keys(turnProcessDetailsAvailable).length > 0
      ? { turnProcessDetailsAvailable }
      : {}),
    ...(args.page.nextCursor ? { nextCursor: args.page.nextCursor } : {}),
  };
  response.approximateBytes = approximateJsonByteLength(response);
  return response;
}

export function materializeCodexAppServerItemDetail(args: {
  sessionId: string;
  providerSessionId: string;
  providerTurnId: string;
  item: unknown;
}): ConversationEvidencePage {
  return materializeCodexAppServerTurnItems({
    sessionId: args.sessionId,
    providerSessionId: args.providerSessionId,
    providerTurnId: args.providerTurnId,
    items: [args.item],
  });
}

export function materializeCodexAppServerTurnItems(args: {
  sessionId: string;
  providerSessionId: string;
  providerTurnId: string;
  items: unknown[];
}): ConversationEvidencePage {
  return materializeCodexAppServerTurnsPage({
    sessionId: args.sessionId,
    providerSessionId: args.providerSessionId,
    page: {
      data: [
        {
          id: args.providerTurnId,
          status: "completed",
          itemsView: "full",
          items: args.items,
        },
      ],
    },
    includeRaw: true,
  });
}
