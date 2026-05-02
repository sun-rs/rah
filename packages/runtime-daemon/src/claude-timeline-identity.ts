import type { TimelineIdentity, TimelineItem } from "@rah/runtime-protocol";
import { createTimelineIdentity } from "./timeline-identity";

type ClaudeTimelineItemKind = Extract<
  TimelineItem,
  { kind: "user_message" | "assistant_message" | "system" }
>["kind"];

export function createClaudeTimelineIdentity(args: {
  providerSessionId?: string | undefined;
  recordUuid: string;
  itemKind: ClaudeTimelineItemKind;
  origin: "live" | "history";
  partIndex?: number;
  confidence?: TimelineIdentity["confidence"];
}): TimelineIdentity {
  const partIndex = args.partIndex ?? 0;
  return createTimelineIdentity({
    provider: "claude",
    ...(args.providerSessionId !== undefined ? { providerSessionId: args.providerSessionId } : {}),
    turnKey: `record:${args.recordUuid}`,
    itemKind: args.itemKind,
    itemKey: partIndex === 0 ? args.recordUuid : `${args.recordUuid}:part:${partIndex}`,
    origin: args.origin,
    confidence: args.confidence ?? "native",
    sourceCursor: {
      providerMessageId: args.recordUuid,
      partIndex,
    },
  });
}
