import type {
  CouncilMcpRequest,
  CouncilMcpResponse,
  CouncilMessage,
  CouncilRoomSnapshot,
} from "@rah/runtime-protocol";
import { CouncilStore } from "./council-store";

function stringArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberArg(args: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = args?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function handleCouncilMcpRequest(
  store: CouncilStore,
  request: CouncilMcpRequest,
): CouncilMcpResponse {
  store.requireAgent(request.roomId, request.actorId);
  const args = request.arguments;
  switch (request.tool) {
    case "channel_join": {
      const room = store.setAgentStatus(request.roomId, request.actorId, "idle", "joined");
      return { ok: true, result: room };
    }
    case "channel_post": {
      const content = stringArg(args, "content") ?? stringArg(args, "text");
      if (!content) {
        throw new Error("channel_post requires content.");
      }
      const replyTo = numberArg(args, "reply_to");
      const message = store.appendMessage({
        roomId: request.roomId,
        actorId: request.actorId,
        role: "agent",
        text: content,
        ...(replyTo !== undefined ? { replyTo } : {}),
      });
      return { ok: true, result: message satisfies CouncilMessage };
    }
    case "channel_wait_new":
    case "channel_history": {
      const sinceMessageId = numberArg(args, "since_id") ?? numberArg(args, "sinceMessageId");
      const limit = numberArg(args, "limit");
      const snapshot = store.snapshot(request.roomId, {
        ...(sinceMessageId !== undefined ? { sinceMessageId } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return { ok: true, result: snapshot.messages };
    }
    case "channel_set_status": {
      const phase = stringArg(args, "phase") ?? "idle";
      const detail = stringArg(args, "detail");
      const allowed = new Set(["starting", "waiting", "thinking", "idle", "blocked", "failed", "stopped"]);
      const status = allowed.has(phase) ? phase as Parameters<CouncilStore["setAgentStatus"]>[2] : "idle";
      const snapshot = store.setAgentStatus(request.roomId, request.actorId, status, detail);
      return { ok: true, result: snapshot satisfies CouncilRoomSnapshot };
    }
    default:
      throw new Error(`Unsupported council MCP tool: ${request.tool}`);
  }
}
