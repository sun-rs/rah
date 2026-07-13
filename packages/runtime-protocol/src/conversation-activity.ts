import type {
  ConversationActivityKind,
  ConversationActivitySummary,
  ConversationItemProjection,
} from "./conversation";
import type {
  MessagePartKind,
  ObservationKind,
  TimelineItem,
  ToolFamily,
} from "./events";

const ACTIVITY_ORDER: readonly ConversationActivityKind[] = [
  "thinking",
  "command",
  "file_read",
  "file_change",
  "search",
  "web",
  "git",
  "subagent",
  "permission",
  "plan",
  "automation",
  "tool",
];

export function conversationActivityKindForToolFamily(
  family: ToolFamily,
): ConversationActivityKind {
  switch (family) {
    case "shell":
    case "test":
    case "build":
    case "lint":
      return "command";
    case "file_read":
      return "file_read";
    case "file_write":
    case "file_edit":
    case "patch":
    case "notebook":
    case "media":
    case "preview":
      return "file_change";
    case "search":
      return "search";
    case "fetch":
    case "web_search":
    case "web_fetch":
    case "browser":
      return "web";
    case "git":
    case "worktree":
      return "git";
    case "subagent":
      return "subagent";
    case "plan":
    case "todo":
      return "plan";
    case "automation":
      return "automation";
    default:
      return "tool";
  }
}

export function conversationActivityKindForObservation(
  kind: ObservationKind,
): ConversationActivityKind {
  switch (kind) {
    case "command.run":
    case "test.run":
    case "build.run":
    case "lint.run":
      return "command";
    case "file.read":
    case "file.list":
    case "media.read":
      return "file_read";
    case "file.write":
    case "file.edit":
    case "patch.apply":
      return "file_change";
    case "file.search":
    case "workspace.scan":
      return "search";
    case "web.search":
    case "web.fetch":
      return "web";
    case "git.status":
    case "git.diff":
    case "git.apply":
    case "worktree.setup":
      return "git";
    case "subagent.lifecycle":
      return "subagent";
    case "permission.change":
    case "question.side":
      return "permission";
    case "plan.update":
    case "todo.update":
      return "plan";
    case "automation.run":
      return "automation";
    default:
      return "tool";
  }
}

export function conversationActivityKindForTimeline(
  item: TimelineItem,
): ConversationActivityKind | null {
  switch (item.kind) {
    case "assistant_message":
    case "reasoning":
    case "compaction":
      return "thinking";
    case "plan":
    case "step":
    case "todo":
      return "plan";
    case "side_question":
      return "permission";
    default:
      return null;
  }
}

export function conversationActivityKindForMessagePart(
  kind: MessagePartKind,
): ConversationActivityKind {
  switch (kind) {
    case "reasoning":
    case "compaction":
      return "thinking";
    case "agent":
    case "subtask":
      return "subagent";
    case "patch":
    case "file":
    case "media":
      return "file_change";
    case "step":
      return "plan";
    default:
      return "tool";
  }
}

export function conversationActivityKindForItem(
  item: ConversationItemProjection,
): ConversationActivityKind | null {
  if (item.role !== "process") return null;
  switch (item.content.kind) {
    case "timeline":
      return conversationActivityKindForTimeline(item.content.item);
    case "tool":
      return conversationActivityKindForToolFamily(item.content.toolCall.family);
    case "observation":
      return conversationActivityKindForObservation(item.content.observation.kind);
    case "permission":
      return "permission";
    case "operation":
      return item.content.operation.kind === "automation" ? "automation" : "tool";
    case "message_part":
      return conversationActivityKindForMessagePart(item.content.part.kind);
  }
}

function numericExitCode(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function conversationActivityFailureDisposition(
  item: ConversationItemProjection,
): "none" | "issue" | "failure" {
  if (item.status !== "failed") return "none";
  if (
    item.content.kind === "observation" &&
    item.content.observation.exitCode !== undefined
  ) {
    return "issue";
  }
  if (
    item.content.kind === "tool" &&
    numericExitCode(item.content.toolCall.result?.exitCode) !== undefined
  ) {
    return "issue";
  }
  return "failure";
}

export function summarizeConversationActivities(
  items: readonly ConversationItemProjection[],
): ConversationActivitySummary[] {
  const summaries = new Map<ConversationActivityKind, ConversationActivitySummary>();
  for (const item of items) {
    const kind = conversationActivityKindForItem(item);
    if (!kind) continue;
    const summary = summaries.get(kind) ?? {
      kind,
      totalCount: 0,
      runningCount: 0,
      interruptedCount: 0,
      failureCount: 0,
      issueCount: 0,
    };
    summary.totalCount += 1;
    if (item.status === "pending" || item.status === "running") {
      summary.runningCount += 1;
    } else if (item.status === "interrupted") {
      summary.interruptedCount += 1;
    }
    const failure = conversationActivityFailureDisposition(item);
    if (failure === "issue") summary.issueCount += 1;
    if (failure === "failure") summary.failureCount += 1;
    summaries.set(kind, summary);
  }
  return ACTIVITY_ORDER.flatMap((kind) => {
    const summary = summaries.get(kind);
    return summary ? [summary] : [];
  });
}
