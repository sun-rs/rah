import type { TimelineIdentity, TimelineItem, TimelineTurnIdentity } from "@rah/runtime-protocol";
import { createTimelineIdentity, createTimelineTurnIdentity } from "./timeline-identity";

type CodexTimelineItemKind = Extract<
  TimelineItem,
  { kind: "user_message" | "assistant_message" | "reasoning" | "plan" | "system" | "compaction" }
>["kind"];

export function createCodexTimelineIdentity(args: {
  providerSessionId?: string | undefined;
  turnId: string;
  itemKind: CodexTimelineItemKind;
  itemIndex: number;
  origin: "live" | "history";
  providerEventId?: string;
  providerMessageId?: string;
  confidence?: TimelineIdentity["confidence"];
}): TimelineIdentity {
  return createTimelineIdentity({
    provider: "codex",
    ...(args.providerSessionId !== undefined ? { providerSessionId: args.providerSessionId } : {}),
    turnKey: `turn:${args.turnId}`,
    itemKind: args.itemKind,
    itemKey: `item:${args.itemIndex}`,
    origin: args.origin,
    confidence: args.confidence ?? "derived",
    sourceCursor: {
      itemIndex: args.itemIndex,
      ...(args.providerEventId !== undefined ? { providerEventId: args.providerEventId } : {}),
      ...(args.providerMessageId !== undefined ? { providerMessageId: args.providerMessageId } : {}),
    },
  });
}

export function createCodexLiveEphemeralTimelineIdentity(args: {
  providerSessionId?: string | undefined;
  turnId: string;
  itemKind: CodexTimelineItemKind;
  itemKey: string;
  providerEventId?: string;
  providerMessageId?: string;
  confidence?: TimelineIdentity["confidence"];
}): TimelineIdentity {
  return createTimelineIdentity({
    provider: "codex",
    ...(args.providerSessionId !== undefined ? { providerSessionId: args.providerSessionId } : {}),
    turnKey: `turn:${args.turnId}`,
    itemKind: args.itemKind,
    itemKey: `live:${args.itemKind}:${args.itemKey}`,
    origin: "live",
    confidence: args.confidence ?? "derived",
    sourceCursor: {
      ...(args.providerEventId !== undefined ? { providerEventId: args.providerEventId } : {}),
      ...(args.providerMessageId !== undefined ? { providerMessageId: args.providerMessageId } : {}),
    },
  });
}

export function createCodexTimelineTurnIdentity(args: {
  providerSessionId?: string | undefined;
  turnId: string;
  origin: "live" | "history";
  confidence?: TimelineIdentity["confidence"];
}): TimelineTurnIdentity {
  return createTimelineTurnIdentity({
    provider: "codex",
    ...(args.providerSessionId !== undefined ? { providerSessionId: args.providerSessionId } : {}),
    turnKey: `turn:${args.turnId}`,
    origin: args.origin,
    confidence: args.confidence ?? "derived",
  });
}
