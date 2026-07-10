import type { RahEvent, SessionHistoryPageResponse } from "@rah/runtime-protocol";
import {
  createCodexAppServerTranslationState,
  translateCodexAppServerThreadSnapshot,
} from "./codex-app-server-activity";
import { EventBus } from "./event-bus";
import { applyProviderActivity } from "./provider-activity";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";

export interface CodexAppServerTurnsPage {
  data: unknown[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
}

export function materializeCodexAppServerTurnsPage(args: {
  sessionId: string;
  providerSessionId: string;
  page: CodexAppServerTurnsPage;
}): SessionHistoryPageResponse {
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
    .map(
      (event, index) =>
        ({
          ...event,
          id: `codex-turn-page:${args.providerSessionId}:${index}`,
          seq: index + 1,
          sessionId: args.sessionId,
        }) as RahEvent,
    );
  const response: SessionHistoryPageResponse = {
    sessionId: args.sessionId,
    events,
    detailMode: "summary",
    ...(args.page.nextCursor ? { nextCursor: args.page.nextCursor } : {}),
  };
  response.approximateBytes = Buffer.byteLength(JSON.stringify(response), "utf8");
  return response;
}
