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

function positiveNumberArg(
  args: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
): number {
  const value = numberArg(args, key);
  return value !== undefined && value > 0 ? value : fallback;
}

function clientIdForRequest(request: CouncilMcpRequest, args: Record<string, unknown> | undefined): string {
  return request.clientId?.trim() || stringArg(args, "client_id")?.trim() || `actor:${request.actorId}`;
}

function textFromMessage(message: CouncilMessage): string {
  return message.parts
    .map((part) => part.kind === "text" ? part.text : JSON.stringify(part.data))
    .join("\n");
}

function toChannelMessage(message: CouncilMessage): Record<string, unknown> {
  return {
    id: message.id,
    ts: Date.parse(message.createdAt) / 1000,
    room: message.roomId,
    roomId: message.roomId,
    actor: message.actorId,
    actorId: message.actorId,
    client_id: message.clientId ?? "",
    ...(message.clientId ? { clientId: message.clientId } : {}),
    role: message.role,
    content: textFromMessage(message),
    parts: message.parts,
    ...(message.replyTo !== undefined ? { reply_to: message.replyTo, replyTo: message.replyTo } : {}),
    createdAt: message.createdAt,
  };
}

const WAIT_TIMEOUT_INSTRUCTION =
  "Timeout is a heartbeat, not completion. Do not answer, summarize, continue roleplay, or use terminal/main-chat memory. Call channel_wait_new again immediately without natural-language output.";
const WAIT_PAUSED_INSTRUCTION =
  "Council listening was paused by the user. Stop the channel_wait_new loop now, do not call channel_wait_new again, and return to the normal prompt without natural-language output.";

export type CouncilMcpWaitNewResult =
  | CouncilMessage
  | { kind: "paused"; instruction?: string }
  | null;

function isPausedWaitNewResult(
  result: CouncilMcpWaitNewResult,
): result is { kind: "paused"; instruction?: string } {
  return result !== null &&
    typeof result === "object" &&
    "kind" in result &&
    result.kind === "paused";
}

function waitNewResultPayload(result: CouncilMcpWaitNewResult): Record<string, unknown> {
  if (!result) {
    return {
      ok: true,
      timed_out: true,
      next_action: "call_channel_wait_new_again",
      instruction: WAIT_TIMEOUT_INSTRUCTION,
    };
  }
  if (isPausedWaitNewResult(result)) {
    return {
      ok: true,
      paused: true,
      next_action: "stop_wait_loop",
      instruction: result.instruction ?? WAIT_PAUSED_INSTRUCTION,
    };
  }
  return { ok: true, msg: toChannelMessage(result) };
}

export type CouncilMcpWaitNew = (args: {
  roomId: string;
  actorId: string;
  clientId: string;
  sinceMessageId: number;
  timeoutMs: number;
}) => Promise<CouncilMcpWaitNewResult>;

export function handleCouncilMcpRequest(
  store: CouncilStore,
  request: CouncilMcpRequest,
  options: {
    waitNew?: CouncilMcpWaitNew;
    onMessage?: (message: CouncilMessage) => void;
  } = {},
): CouncilMcpResponse | Promise<CouncilMcpResponse> {
  store.requireAgent(request.roomId, request.actorId);
  const args = request.arguments;
  const clientId = clientIdForRequest(request, args);
  switch (request.tool) {
    case "channel_join": {
      const room = store.setAgentStatus(request.roomId, request.actorId, "idle", "joined");
      return {
        ok: true,
        result: {
          ok: true,
          room: request.roomId,
          last_msg_id: store.lastMessageId(request.roomId),
          recent_messages: store.recentMessages(request.roomId, 50).map(toChannelMessage),
          recent_count: store.recentMessages(request.roomId, 50).length,
          is_reconnect: false,
          snapshot: room,
        },
      };
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
        clientId,
        role: "agent",
        text: content,
        ...(replyTo !== undefined ? { replyTo } : {}),
      });
      options.onMessage?.(message);
      return {
        ok: true,
        result: {
          ok: true,
          msg_id: message.id,
          ts: Date.parse(message.createdAt) / 1000,
          message: toChannelMessage(message),
        },
      };
    }
    case "channel_wait_new": {
      const sinceMessageId = numberArg(args, "since_id") ?? numberArg(args, "sinceMessageId") ?? 0;
      const timeoutS = Math.min(120, positiveNumberArg(args, "timeout_s", 60));
      const immediate = store.messagesSince(request.roomId, sinceMessageId, {
        limit: 1,
        excludeClientId: clientId,
        excludeActorIdWhenClientMissing: request.actorId,
      })[0] ?? null;
      if (immediate || !options.waitNew) {
        return {
          ok: true,
          result: waitNewResultPayload(immediate),
        };
      }
      return options.waitNew({
        roomId: request.roomId,
        actorId: request.actorId,
        clientId,
        sinceMessageId,
        timeoutMs: timeoutS * 1000,
      }).then((message) => ({
        ok: true,
        result: waitNewResultPayload(message),
      }));
    }
    case "channel_history": {
      const sinceMessageId = numberArg(args, "since_id") ?? numberArg(args, "sinceMessageId");
      const limit = numberArg(args, "limit");
      return {
        ok: true,
        result: {
          ok: true,
          messages: store.messagesSince(request.roomId, sinceMessageId ?? 0, {
            limit: limit ?? 50,
          }).map(toChannelMessage),
        },
      };
    }
    case "channel_peek_inbox": {
      const sinceMessageId = numberArg(args, "since_id") ?? numberArg(args, "sinceMessageId") ?? 0;
      const limit = numberArg(args, "limit") ?? 50;
      return {
        ok: true,
        result: {
          ok: true,
          messages: store.messagesSince(request.roomId, sinceMessageId, {
            limit,
            excludeClientId: clientId,
            excludeActorIdWhenClientMissing: request.actorId,
          }).map(toChannelMessage),
        },
      };
    }
    case "channel_state": {
      const state = store.roomState(request.roomId);
      return {
        ok: true,
        result: {
          ok: true,
          room: state.room,
          agents: state.agents,
          active_agents: state.agents.map((agent) => ({
            actor: agent.id,
            actorId: agent.id,
            status: agent.status,
            ...(agent.lastStatusDetail ? { detail: agent.lastStatusDetail } : {}),
          })),
          claims: state.claims.map((claim) => ({
            path: claim.path,
            actor: claim.actorId,
            actorId: claim.actorId,
            claimed_at: claim.claimedAt,
            claimedAt: claim.claimedAt,
          })),
          controls: state.controls,
          last_msg_id: state.lastMessageId,
          lastMessageId: state.lastMessageId,
        },
      };
    }
    case "channel_set_status": {
      const phase = stringArg(args, "phase") ?? "idle";
      const detail = stringArg(args, "detail");
      const allowed = new Set(["starting", "waiting", "thinking", "idle", "blocked", "failed", "stopped"]);
      const status = allowed.has(phase) ? phase as Parameters<CouncilStore["setAgentStatus"]>[2] : "idle";
      const snapshot = store.setAgentStatus(request.roomId, request.actorId, status, detail);
      return { ok: true, result: snapshot satisfies CouncilRoomSnapshot };
    }
    case "channel_claim_file": {
      const filePath = stringArg(args, "path");
      if (!filePath) {
        throw new Error("channel_claim_file requires path.");
      }
      const claim = store.claimFile(request.roomId, request.actorId, filePath);
      return { ok: true, result: { ok: true, path: claim.path, actor: claim.actorId, claim } };
    }
    case "channel_release_file": {
      const filePath = stringArg(args, "path");
      if (!filePath) {
        throw new Error("channel_release_file requires path.");
      }
      return {
        ok: true,
        result: { ok: true, path: filePath, released: store.releaseFile(request.roomId, request.actorId, filePath) },
      };
    }
    case "channel_list_claims": {
      return {
        ok: true,
        result: {
          ok: true,
          claims: store.listClaims(request.roomId).map((claim) => ({
            path: claim.path,
            actor: claim.actorId,
            actorId: claim.actorId,
            claimed_at: claim.claimedAt,
            claimedAt: claim.claimedAt,
          })),
        },
      };
    }
    case "channel_send_control": {
      const target = stringArg(args, "target");
      const action = stringArg(args, "action");
      if (!target || !action) {
        throw new Error("channel_send_control requires target and action.");
      }
      const taskId = stringArg(args, "task_id") ?? stringArg(args, "taskId");
      return {
        ok: true,
        result: {
          ok: true,
          control: store.appendControl({
            roomId: request.roomId,
            fromActorId: request.actorId,
            targetActorId: target,
            action,
            ...(taskId ? { taskId } : {}),
            ...(args?.data !== undefined ? { data: args.data } : {}),
          }),
        },
      };
    }
    case "channel_peek_control": {
      const controls = store.takeControls(request.roomId, request.actorId);
      return { ok: true, result: { ok: true, controls, count: controls.length } };
    }
    default:
      throw new Error(`Unsupported council MCP tool: ${request.tool}`);
  }
}
