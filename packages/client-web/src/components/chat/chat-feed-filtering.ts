import type { ProviderKind } from "@rah/runtime-protocol";
import type { FeedEntry } from "../../types";

const TOOL_BACKED_OBSERVATION_KINDS = new Set([
  "file.read",
  "file.list",
  "file.search",
  "file.write",
  "file.edit",
  "patch.apply",
  "command.run",
  "test.run",
  "build.run",
  "lint.run",
  "git.status",
  "git.diff",
  "git.apply",
  "web.search",
  "web.fetch",
  "mcp.call",
  "subagent.lifecycle",
]);

export function visibleFeedEntries(
  feed: FeedEntry[],
  hideToolCalls: boolean,
  hideOpenCodeReasoning = false,
  provider?: ProviderKind,
): FeedEntry[] {
  const toolIds = new Set(
    feed.flatMap((entry) =>
      entry.kind === "tool_call" ? [entry.toolCall.id] : [],
    ),
  );

  return feed.filter((entry) => {
    if (hideToolCalls && entry.kind === "tool_call" && entry.status === "completed") {
      return false;
    }
    if (
      hideOpenCodeReasoning &&
      entry.kind === "timeline" &&
      entry.item.kind === "reasoning" &&
      (entry.sourceProvider ?? provider) === "opencode"
    ) {
      return false;
    }
    if (entry.kind !== "observation") {
      return true;
    }
    if (
      hideToolCalls &&
      entry.status === "completed" &&
      TOOL_BACKED_OBSERVATION_KINDS.has(entry.observation.kind)
    ) {
      return false;
    }
    const providerCallId = entry.observation.subject?.providerCallId;
    if (!providerCallId) {
      return true;
    }
    if (!TOOL_BACKED_OBSERVATION_KINDS.has(entry.observation.kind)) {
      return true;
    }
    return !toolIds.has(providerCallId);
  });
}
