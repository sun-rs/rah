import type { TimelineIdentity, TimelineItem } from "@rah/runtime-protocol";
import { createTimelineIdentity } from "./timeline-identity";

type OpenCodeTimelineItemKind = Extract<
  TimelineItem,
  { kind: "user_message" | "assistant_message" | "reasoning" }
>["kind"];

export function createOpenCodeTimelineIdentity(args: {
  providerSessionId: string;
  messageId: string;
  itemKind: OpenCodeTimelineItemKind;
  origin: "live" | "history";
  partId?: string;
  confidence?: TimelineIdentity["confidence"];
}): TimelineIdentity {
  return createTimelineIdentity({
    provider: "opencode",
    providerSessionId: args.providerSessionId,
    turnKey: `message:${args.messageId}`,
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
