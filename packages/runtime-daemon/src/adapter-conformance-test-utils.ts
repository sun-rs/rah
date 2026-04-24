import {
  formatRahConformanceReport,
  validateRahEventSequence,
  type EventAuthority,
  type EventChannel,
  type ProviderKind,
  type RahEvent,
} from "@rah/runtime-protocol";
import { EventBus } from "./event-bus";
import { applyProviderActivity, type ProviderActivity } from "./provider-activity";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";

export interface TranslatedActivity {
  activity: ProviderActivity;
  ts?: string;
  channel?: EventChannel;
  authority?: EventAuthority;
  raw?: unknown;
}

export interface AdapterConformanceHarness {
  services: {
    eventBus: EventBus;
    ptyHub: PtyHub;
    sessionStore: SessionStore;
  };
  sessionId: string;
  apply(items: TranslatedActivity[]): RahEvent[];
  events(): RahEvent[];
  assertConforms(options?: { requireTurnScopedWork?: boolean }): RahEvent[];
}

export function createAdapterConformanceHarness(params: {
  provider: ProviderKind;
  cwd?: string;
  rootDir?: string;
  title?: string;
}): AdapterConformanceHarness {
  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const state = services.sessionStore.createManagedSession({
    provider: params.provider,
    launchSource: "web",
    cwd: params.cwd ?? "/workspace/demo",
    rootDir: params.rootDir ?? params.cwd ?? "/workspace/demo",
    title: params.title ?? `${params.provider} fixture`,
  });
  return {
    services,
    sessionId: state.session.id,
    apply(items) {
      const events: RahEvent[] = [];
      for (const item of items) {
        events.push(
          ...applyProviderActivity(
            services,
            state.session.id,
            {
              provider: params.provider,
              ...(item.channel !== undefined ? { channel: item.channel } : {}),
              ...(item.authority !== undefined ? { authority: item.authority } : {}),
              ...(item.raw !== undefined ? { raw: item.raw } : {}),
              ...(item.ts !== undefined ? { ts: item.ts } : {}),
            },
            item.activity,
          ),
        );
      }
      return events;
    },
    events() {
      return services.eventBus.list({ sessionIds: [state.session.id] });
    },
    assertConforms(options = {}) {
      const events = services.eventBus.list({ sessionIds: [state.session.id] });
      const report = validateRahEventSequence(events, {
        requireRawForHeuristic: true,
        requireTurnScopedWork: options.requireTurnScopedWork ?? false,
      });
      if (!report.ok) {
        throw new Error(formatRahConformanceReport(report));
      }
      return events;
    },
  };
}

export function summarizeRahEvents(events: RahEvent[]) {
  return events.map((event) => {
    switch (event.type) {
      case "timeline.item.added":
      case "timeline.item.updated":
        return {
          type: event.type,
          turnId: event.turnId,
          kind: event.payload.item.kind,
          text:
            "text" in event.payload.item
              ? event.payload.item.text
              : "title" in event.payload.item
                ? event.payload.item.title
                : undefined,
        };
      case "message.part.added":
      case "message.part.updated":
      case "message.part.delta":
        return {
          type: event.type,
          turnId: event.turnId,
          kind: event.payload.part.kind,
          messageId: event.payload.part.messageId,
          partId: event.payload.part.partId,
        };
      case "tool.call.started":
        return {
          type: event.type,
          turnId: event.turnId,
          family: event.payload.toolCall.family,
          id: event.payload.toolCall.id,
          providerToolName: event.payload.toolCall.providerToolName,
        };
      case "tool.call.completed":
        return {
          type: event.type,
          turnId: event.turnId,
          family: event.payload.toolCall.family,
          id: event.payload.toolCall.id,
          providerToolName: event.payload.toolCall.providerToolName,
        };
      case "tool.call.delta":
        return {
          type: event.type,
          turnId: event.turnId,
          id: event.payload.toolCallId,
        };
      case "tool.call.failed":
        return {
          type: event.type,
          turnId: event.turnId,
          id: event.payload.toolCallId,
          error: event.payload.error,
        };
      case "observation.started":
      case "observation.updated":
      case "observation.completed":
      case "observation.failed":
        return {
          type: event.type,
          turnId: event.turnId,
          kind: event.payload.observation.kind,
          id: event.payload.observation.id,
          status: event.payload.observation.status,
        };
      case "permission.requested":
        return {
          type: event.type,
          turnId: event.turnId,
          kind: event.payload.request.kind,
          id: event.payload.request.id,
        };
      case "permission.resolved":
        return {
          type: event.type,
          turnId: event.turnId,
          id: event.payload.resolution.requestId,
          behavior: event.payload.resolution.behavior,
        };
      case "operation.started":
      case "operation.resolved":
      case "operation.requested":
        return {
          type: event.type,
          turnId: event.turnId,
          kind: event.payload.operation.kind,
          name: event.payload.operation.name,
        };
      case "usage.updated":
        return {
          type: event.type,
          turnId: event.turnId,
          usedTokens: event.payload.usage.usedTokens,
        };
      default:
        return {
          type: event.type,
          turnId: event.turnId,
        };
    }
  });
}
