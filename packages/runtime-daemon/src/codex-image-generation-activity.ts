import type { ToolCall } from "@rah/runtime-protocol";
import type { ProviderActivity } from "./provider-activity";

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function codexImageGenerationActivities(
  item: Record<string, unknown>,
  phase: "started" | "completed",
  turnId: string,
): ProviderActivity[] {
  const id = optionalString(item, "id") ?? "image-generation";
  const savedPath = optionalString(item, "savedPath");
  const status = optionalString(item, "status");
  const toolCall: ToolCall = {
    id,
    family: "media",
    providerToolName: "imageGeneration",
    title: "Generate image",
    ...(status ? { result: { status } } : {}),
    detail: {
      artifacts: [
        ...(savedPath ? [{ kind: "image" as const, path: savedPath }] : []),
        { kind: "json", label: "item", value: item },
      ],
    },
  };
  if (phase === "started" || status === "inProgress" || status === "running") {
    return [{ type: "tool_call_started", turnId, toolCall }];
  }
  return status === "failed"
    ? [{ type: "tool_call_failed", turnId, toolCallId: id, error: "Image generation failed" }]
    : [{ type: "tool_call_completed", turnId, toolCall }];
}
