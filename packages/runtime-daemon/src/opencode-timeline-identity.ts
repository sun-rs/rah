import type { TimelineIdentity, TimelineItem, TimelineTurnIdentity } from "@rah/runtime-protocol";
import { createTimelineIdentity, createTimelineTurnIdentity } from "./timeline-identity";

type OpenCodeTimelineItemKind = Extract<
  TimelineItem,
  { kind: "user_message" | "assistant_message" | "reasoning" }
>["kind"];

export function createOpenCodeTimelineIdentity(args: {
  providerSessionId: string;
  messageId: string;
  turnMessageId?: string;
  itemKind: OpenCodeTimelineItemKind;
  origin: "live" | "history";
  partId?: string;
  confidence?: TimelineIdentity["confidence"];
}): TimelineIdentity {
  return createTimelineIdentity({
    provider: "opencode",
    providerSessionId: args.providerSessionId,
    turnKey: `message:${args.turnMessageId ?? args.messageId}`,
    itemKind: args.itemKind,
    itemKey: args.partId ?? args.messageId,
    origin: args.origin,
    confidence: args.confidence ?? "native",
    sourceCursor: {
      providerMessageId: args.messageId,
      ...(args.partId !== undefined ? { providerEventId: args.partId } : {}),
    },
  });
}

export function createOpenCodeTimelineTurnIdentity(args: {
  providerSessionId: string;
  messageId: string;
  origin: "live" | "history";
  confidence?: TimelineIdentity["confidence"];
}): TimelineTurnIdentity {
  return createTimelineTurnIdentity({
    provider: "opencode",
    providerSessionId: args.providerSessionId,
    turnKey: `message:${args.messageId}`,
    origin: args.origin,
    confidence: args.confidence ?? "native",
  });
}
