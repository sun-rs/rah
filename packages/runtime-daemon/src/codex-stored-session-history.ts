import { readFileSync, statSync } from "node:fs";
import type {
  AttachSessionRequest,
  ManagedSession,
  RahEvent,
  SessionHistoryPageResponse,
} from "@rah/runtime-protocol";
import type {
  FrozenHistoryBoundary,
  FrozenHistoryPageLoader,
} from "./history-snapshots";
import type { RuntimeServices } from "./provider-adapter";
import { EventBus } from "./event-bus";
import { PtyHub } from "./pty-hub";
import { applyProviderActivity } from "./provider-activity";
import {
  createCodexRolloutTranslationState,
  finalizeCodexRolloutTranslationState,
  translateCodexRolloutLine,
} from "./codex-rollout-activity";
import { createLineHistoryWindowTranslator } from "./line-history-checkpoint";
import { createLineFrozenHistoryPageLoader } from "./line-history-pager";
import { SessionStore } from "./session-store";
import { selectSemanticRecentWindow } from "./semantic-history-window";
import { readTrailingLinesWindow } from "./file-snippets";
import {
  REHYDRATED_CAPABILITIES,
} from "./codex-stored-session-types";
import type { CodexStoredSessionRecord } from "./codex-stored-session-types";
import { runtimeDescriptorForStoredHistory } from "./session-runtime-descriptor";

const SYSTEM_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

function makeCodexFrozenHistoryBoundary(
  rolloutPath: string,
  endOffset: number,
  finalizeUnterminatedTools: boolean,
): FrozenHistoryBoundary {
  return {
    kind: "frozen",
    sourceRevision: JSON.stringify({
      provider: "codex",
      rolloutPath,
      endOffset,
      finalizeUnterminatedTools,
    }),
  };
}

function isCodexTranslationSafeBoundaryLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const payload =
      parsed.payload && typeof parsed.payload === "object" && !Array.isArray(parsed.payload)
        ? (parsed.payload as Record<string, unknown>)
        : null;
    if (!payload) {
      return false;
    }
    if (parsed.type === "session_meta" && typeof payload.id === "string") {
      return true;
    }
    if (parsed.type === "turn_context" && typeof payload.turn_id === "string") {
      return true;
    }
    return (
      parsed.type === "event_msg" &&
      payload.type === "task_started" &&
      typeof payload.turn_id === "string"
    );
  } catch {
    return false;
  }
}

function payloadRecordFromCodexLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return parsed.payload && typeof parsed.payload === "object" && !Array.isArray(parsed.payload)
      ? (parsed.payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hasOrphanCodexFunctionCallOutput(lines: readonly string[]): boolean {
  const started = new Set<string>();
  const completed = new Set<string>();
  for (const line of lines) {
    const payload = payloadRecordFromCodexLine(line);
    if (!payload) {
      continue;
    }
    if (payload.type === "function_call" && typeof payload.call_id === "string") {
      started.add(payload.call_id);
      continue;
    }
    if (payload.type === "function_call_output" && typeof payload.call_id === "string") {
      completed.add(payload.call_id);
    }
  }
  return [...completed].some((callId) => !started.has(callId));
}

function readCodexRolloutWindowWithToolContext(
  rolloutPath: string,
  options: { endOffset: number; lineBudget: number },
) {
  let maxLines = Math.max(options.lineBudget, 1);
  const maxContextLines = Math.max(maxLines, 8192);
  for (;;) {
    const window = readTrailingLinesWindow(rolloutPath, {
      endOffset: options.endOffset,
      maxLines,
      chunkBytes: 8 * 1024,
    });
    if (
      window.startOffset <= 0 ||
      maxLines >= maxContextLines ||
      !hasOrphanCodexFunctionCallOutput(window.lines)
    ) {
      return window;
    }
    maxLines = Math.min(maxContextLines, Math.max(maxLines + 16, maxLines * 2));
  }
}

function sameTimelineText(
  left: RahEvent | undefined,
  right: RahEvent,
): boolean {
  if (left?.type !== "timeline.item.added" || right.type !== "timeline.item.added") {
    return false;
  }
  const leftItem = left.payload.item;
  const rightItem = right.payload.item;
  if (leftItem.kind !== rightItem.kind) {
    return false;
  }
  if (
    leftItem.kind === "user_message" ||
    leftItem.kind === "assistant_message" ||
    leftItem.kind === "reasoning"
  ) {
    return leftItem.text === (rightItem as typeof leftItem).text;
  }
  return false;
}

function collapseDuplicateTimelineEvents(events: RahEvent[]): RahEvent[] {
  const next: RahEvent[] = [];
  const seenCanonicalItemIds = new Set<string>();
  for (const event of events) {
    if (
      event.type === "timeline.item.added" &&
      typeof event.payload.identity?.canonicalItemId === "string"
    ) {
      if (seenCanonicalItemIds.has(event.payload.identity.canonicalItemId)) {
        continue;
      }
      seenCanonicalItemIds.add(event.payload.identity.canonicalItemId);
    }
    const previous = next.at(-1);
    if (sameTimelineText(previous, event)) {
      continue;
    }
    next.push(event);
  }
  return next;
}

function codexHistoryPageHasStableTimelineIdentities(events: readonly RahEvent[]): boolean {
  return !events.some((event) => {
    if (event.type !== "timeline.item.added" && event.type !== "timeline.item.updated") {
      return false;
    }
    const kind = event.payload.item.kind;
    if (kind !== "user_message" && kind !== "assistant_message" && kind !== "reasoning") {
      return false;
    }
    return typeof event.payload.identity?.canonicalItemId !== "string";
  });
}

function translateCodexRolloutWindowToHistoryEvents(args: {
  sessionId: string;
  providerSessionId: string;
  cwd: string;
  rootDir: string;
  title?: string;
  preview?: string;
  lines: string[];
  finalizePendingTools?: boolean;
}): RahEvent[] {
  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const temp = services.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: args.providerSessionId,
    launchSource: "web",
    cwd: args.cwd,
    rootDir: args.rootDir,
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.preview !== undefined ? { preview: args.preview } : {}),
  });
  const translationState = createCodexRolloutTranslationState({
    providerSessionId: args.providerSessionId,
  });
  let lastTimestamp: string | undefined;
  for (const line of args.lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const timestamp = (parsed as Record<string, unknown>).timestamp;
      if (typeof timestamp === "string") {
        lastTimestamp = timestamp;
      }
    }
    const translated = translateCodexRolloutLine(parsed, translationState);
    for (const item of translated) {
      applyProviderActivity(
        services,
        temp.session.id,
        {
          provider: "codex",
          ...(item.channel !== undefined ? { channel: item.channel } : {}),
          ...(item.authority !== undefined ? { authority: item.authority } : {}),
          ...(item.raw !== undefined ? { raw: item.raw } : {}),
          ...(item.ts !== undefined ? { ts: item.ts } : {}),
        },
        item.activity,
      );
    }
  }
  if (args.finalizePendingTools) {
    const translated = finalizeCodexRolloutTranslationState(translationState, {
      ...(lastTimestamp !== undefined ? { timestamp: lastTimestamp } : {}),
    });
    for (const item of translated) {
      applyProviderActivity(
        services,
        temp.session.id,
        {
          provider: "codex",
          ...(item.channel !== undefined ? { channel: item.channel } : {}),
          ...(item.authority !== undefined ? { authority: item.authority } : {}),
          ...(item.raw !== undefined ? { raw: item.raw } : {}),
          ...(item.ts !== undefined ? { ts: item.ts } : {}),
        },
        item.activity,
      );
    }
  }
  return collapseDuplicateTimelineEvents(
    services.eventBus
      .list({ sessionIds: [temp.session.id] })
      .map((event) => ({
        ...event,
        id: `history:${event.id}`,
        seq: event.seq + 1_000_000_000,
        sessionId: args.sessionId,
      }))
      .sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq),
  );
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

export function replayCodexStoredSessionRollout(params: {
  services: RuntimeServices;
  sessionId: string;
  record: CodexStoredSessionRecord;
  bannerText?: string;
  finalizeUnterminatedTools?: boolean;
}) {
  const { services, sessionId, record, bannerText } = params;
  if (bannerText !== undefined) {
    services.ptyHub.appendOutput(sessionId, bannerText);
  }

  const translationState = createCodexRolloutTranslationState({
    providerSessionId: record.ref.providerSessionId,
  });
  const lines = readFileSync(record.rolloutPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let lastTimestamp: string | undefined;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const timestamp = (parsed as Record<string, unknown>).timestamp;
      if (typeof timestamp === "string") {
        lastTimestamp = timestamp;
      }
    }
    const translated = translateCodexRolloutLine(parsed, translationState);
    for (const item of translated) {
      applyProviderActivity(
        services,
        sessionId,
        {
          provider: "codex",
          ...(item.channel !== undefined ? { channel: item.channel } : {}),
          ...(item.authority !== undefined ? { authority: item.authority } : {}),
          ...(item.raw !== undefined ? { raw: item.raw } : {}),
          ...(item.ts !== undefined ? { ts: item.ts } : {}),
        },
        item.activity,
      );
    }
  }
  if (params.finalizeUnterminatedTools) {
    const finalized = finalizeCodexRolloutTranslationState(translationState, {
      ...(lastTimestamp !== undefined ? { timestamp: lastTimestamp } : {}),
    });
    for (const item of finalized) {
      applyProviderActivity(
        services,
        sessionId,
        {
          provider: "codex",
          ...(item.channel !== undefined ? { channel: item.channel } : {}),
          ...(item.authority !== undefined ? { authority: item.authority } : {}),
          ...(item.raw !== undefined ? { raw: item.raw } : {}),
          ...(item.ts !== undefined ? { ts: item.ts } : {}),
        },
        item.activity,
      );
    }
  }
}

export function resumeCodexStoredSession(params: {
  services: RuntimeServices;
  record: CodexStoredSessionRecord;
  attach?: AttachSessionRequest;
}): { sessionId: string } {
  const { services, record } = params;
  const state = services.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: record.ref.providerSessionId,
    launchSource: "web",
    cwd: record.ref.cwd ?? process.cwd(),
    rootDir: record.ref.rootDir ?? record.ref.cwd ?? process.cwd(),
    ...(record.ref.title ? { title: record.ref.title } : {}),
    ...(record.ref.preview ? { preview: record.ref.preview } : {}),
    runtime: runtimeDescriptorForStoredHistory(),
    capabilities: REHYDRATED_CAPABILITIES,
  });
  services.ptyHub.ensureSession(state.session.id);
  services.sessionStore.setRuntimeState(state.session.id, "idle");
  const session = services.sessionStore.getSession(state.session.id)!;
  publishSessionBootstrap(services, state.session.id, session.session);
  if (params.attach) {
    services.sessionStore.attachClient({
      sessionId: state.session.id,
      clientId: params.attach.client.id,
      kind: params.attach.client.kind,
      connectionId: params.attach.client.connectionId,
      attachMode: params.attach.mode,
      focus: true,
    });
    services.eventBus.publish({
      sessionId: state.session.id,
      type: "session.attached",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: params.attach.client.id,
        clientKind: params.attach.client.kind,
      },
    });
    if (params.attach.claimControl) {
      services.sessionStore.claimControl(
        state.session.id,
        params.attach.client.id,
        params.attach.client.kind,
      );
      services.eventBus.publish({
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

export function getCodexStoredSessionHistoryPage(params: {
  sessionId: string;
  record: CodexStoredSessionRecord;
  beforeTs?: string;
  limit?: number;
  finalizeUnterminatedTools?: boolean;
}): SessionHistoryPageResponse {
  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const temp = services.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: params.record.ref.providerSessionId,
    launchSource: "web",
    cwd: params.record.ref.cwd ?? process.cwd(),
    rootDir: params.record.ref.rootDir ?? params.record.ref.cwd ?? process.cwd(),
    ...(params.record.ref.title !== undefined ? { title: params.record.ref.title } : {}),
    ...(params.record.ref.preview !== undefined ? { preview: params.record.ref.preview } : {}),
  });

  replayCodexStoredSessionRollout({
    services,
    sessionId: temp.session.id,
    record: params.record,
    ...(params.finalizeUnterminatedTools !== undefined
      ? { finalizeUnterminatedTools: params.finalizeUnterminatedTools }
      : {}),
  });

  const all: RahEvent[] = services.eventBus
    .list({ sessionIds: [temp.session.id] })
    .filter((event) => (params.beforeTs ? event.ts < params.beforeTs : true))
    .map((event) => ({
      ...event,
      id: `history:${event.id}`,
      seq: event.seq + 1_000_000_000,
      sessionId: params.sessionId,
    }))
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
  const collapsed = collapseDuplicateTimelineEvents(all);

  const limit = Math.max(1, params.limit ?? 1000);
  const start = Math.max(0, collapsed.length - limit);
  const events = collapsed.slice(start);
  return {
    sessionId: params.sessionId,
    events,
    ...(start > 0 && events[0] ? { nextBeforeTs: events[0].ts } : {}),
  };
}

export function createCodexStoredSessionFrozenHistoryPageLoader(args: {
  sessionId: string;
  record: CodexStoredSessionRecord;
  finalizeUnterminatedTools?: boolean;
}): FrozenHistoryPageLoader {
  const snapshotEndOffset = statSync(args.record.rolloutPath).size;
  const shouldFinalizeUnterminatedTools = args.finalizeUnterminatedTools === true;
  const boundary = makeCodexFrozenHistoryBoundary(
    args.record.rolloutPath,
    snapshotEndOffset,
    shouldFinalizeUnterminatedTools,
  );
  const translateWindow = createLineHistoryWindowTranslator({
    sessionId: args.sessionId,
    findSafeBoundaryIndex: (lines) => lines.findIndex(isCodexTranslationSafeBoundaryLine),
    translateLines: (lines, context) =>
      translateCodexRolloutWindowToHistoryEvents({
        sessionId: args.sessionId,
        providerSessionId: args.record.ref.providerSessionId,
        cwd: args.record.ref.cwd ?? process.cwd(),
        rootDir: args.record.ref.rootDir ?? args.record.ref.cwd ?? process.cwd(),
        ...(args.record.ref.title !== undefined ? { title: args.record.ref.title } : {}),
        ...(args.record.ref.preview !== undefined ? { preview: args.record.ref.preview } : {}),
        lines: [...lines],
        finalizePendingTools:
          shouldFinalizeUnterminatedTools && context.endOffset >= snapshotEndOffset,
      }),
  });
  return createLineFrozenHistoryPageLoader({
    boundary,
    snapshotEndOffset,
    readWindow: ({ endOffset, lineBudget }) => {
      const window = readCodexRolloutWindowWithToolContext(args.record.rolloutPath, {
        endOffset,
        lineBudget,
      });
      return {
        startOffset: window.startOffset,
        events: translateWindow(window.endOffset, window.lines, window.startOffset),
      };
    },
    selectPage: selectSemanticRecentWindow,
    isPageStable: codexHistoryPageHasStableTimelineIdentities,
  });
}
