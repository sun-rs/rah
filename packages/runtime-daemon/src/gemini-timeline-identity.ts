import type { TimelineIdentity, TimelineItem } from "@rah/runtime-protocol";
import { createTimelineIdentity } from "./timeline-identity";

type GeminiTimelineItemKind = Extract<
  TimelineItem,
  { kind: "user_message" | "assistant_message" | "reasoning" | "system" | "error" }
>["kind"];

export function createGeminiTimelineIdentity(args: {
  providerSessionId: string;
  messageId: string;
  itemKind: GeminiTimelineItemKind;
  origin: "live" | "history";
  partIndex?: number;
  confidence?: TimelineIdentity["confidence"];
}): TimelineIdentity {
  const partIndex = args.partIndex ?? 0;
  return createTimelineIdentity({
    provider: "gemini",
    providerSessionId: args.providerSessionId,
    turnKey: `message:${args.messageId}`,
    itemKind: args.itemKind,
    itemKey: partIndex === 0 ? args.messageId : `${args.messageId}:part:${partIndex}`,
    origin: args.origin,
    confidence: args.confidence ?? "native",
    sourceCursor: {
      providerMessageId: args.messageId,
      partIndex,
    },
  });
}
