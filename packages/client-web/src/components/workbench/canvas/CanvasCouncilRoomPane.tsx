import { MessageSquareText, UsersRound } from "lucide-react";
import type { CouncilRoomSnapshot } from "@rah/runtime-protocol";
import type { ObjectPaneVariant } from "../../../object-pane-variant";
import { OverlayScrollArea } from "../../OverlayScrollArea";

function textFromParts(parts: CouncilRoomSnapshot["messages"][number]["parts"]): string {
  return parts
    .map((part) => part.kind === "text" ? part.text : JSON.stringify(part.data))
    .join("\n");
}

function actorLabel(room: CouncilRoomSnapshot, actorId: string): string {
  if (actorId === "user") {
    return "You";
  }
  if (actorId === "system") {
    return "System";
  }
  return room.agents.find((agent) => agent.id === actorId)?.label ?? actorId;
}

function roomStatusLabel(room: CouncilRoomSnapshot): string {
  if (room.room.status === "stopped") {
    return room.room.phase === "failed" ? "Stopped / Failed" : "Stopped";
  }
  if (room.room.phase === "starting") {
    return "Running / Starting";
  }
  if (room.room.phase === "working") {
    return "Running / Working";
  }
  if (room.room.phase === "waiting_permission") {
    return "Running / Waiting permission";
  }
  return "Running";
}

export function CanvasCouncilRoomPane(props: {
  variant: ObjectPaneVariant;
  room: CouncilRoomSnapshot | null;
  onOpenFullRoom: (roomId: string) => void;
}) {
  if (!props.room) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6 text-center">
        <div>
          <div className="text-sm font-medium text-[var(--app-fg)]">Room unavailable</div>
          <div className="mt-1 text-xs text-[var(--app-hint)]">
            The council room no longer exists or has not loaded yet.
          </div>
        </div>
      </div>
    );
  }

  const latestMessages = props.room.messages.slice(-80);
  const statusLabel = roomStatusLabel(props.room);
  const running = props.room.room.status === "running";

  const chatSurface = (
    <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
      <div className="shrink-0 border-b border-[var(--app-border)] px-3 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-[var(--app-fg)]">
              {props.room.room.title}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--app-hint)]">
              <span
                className={`rounded-full border px-1.5 py-0.5 font-medium ${
                  running
                    ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-[var(--app-border)] bg-[var(--app-subtle-bg)]"
                }`}
              >
                {statusLabel}
              </span>
              <span className="inline-flex items-center gap-1">
                <UsersRound size={12} />
                {props.room.agents.length} agents
              </span>
              <span className="inline-flex items-center gap-1">
                <MessageSquareText size={12} />
                {props.room.messages.length} messages
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => props.onOpenFullRoom(props.room!.room.id)}
            className="inline-flex h-7 shrink-0 items-center rounded-md border border-[var(--app-border)] px-2 text-[11px] font-medium text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
          >
            Open
          </button>
        </div>
      </div>

      <OverlayScrollArea
        className="min-h-0 flex-1"
        viewportClassName="h-full"
        contentClassName="space-y-2 p-3"
        scrollAriaLabel="Council room messages"
      >
        {latestMessages.length > 0 ? (
          latestMessages.map((message) => {
            const text = textFromParts(message.parts);
            return (
              <div
                key={message.id}
                className="rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2"
              >
                <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
                  <span className="min-w-0 truncate font-medium text-[var(--app-fg)]">
                    {actorLabel(props.room!, message.actorId)}
                  </span>
                  <span className="shrink-0 text-[var(--app-hint)]">
                    {new Date(message.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                <div className="line-clamp-6 whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--app-fg)] [overflow-wrap:anywhere]">
                  {text}
                </div>
              </div>
            );
          })
        ) : (
          <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-[var(--app-border)] text-xs text-[var(--app-hint)]">
            No room messages yet.
          </div>
        )}
      </OverlayScrollArea>
    </div>
  );

  if (props.variant === "expanded") {
    return (
      <div className="flex h-full min-h-0 min-w-0">
        <div className="min-w-0 flex-1">{chatSurface}</div>
        <aside className="hidden w-[min(24rem,30vw)] shrink-0 border-l border-[var(--app-border)] bg-[var(--app-subtle-bg)] min-[900px]:flex min-[900px]:flex-col">
          <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--app-border)] px-4">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[var(--app-fg)]">Agents</div>
              <div className="truncate text-xs text-[var(--app-hint)]">
                {props.room.agents.length} room participants
              </div>
            </div>
          </div>
          <OverlayScrollArea
            className="min-h-0 flex-1"
            viewportClassName="h-full"
            contentClassName="space-y-2 p-3"
            scrollAriaLabel="Council room agents"
          >
            {props.room.agents.length > 0 ? (
              props.room.agents.map((agent) => (
                <div
                  key={agent.id}
                  className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2"
                >
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[var(--app-fg)]">
                        {agent.label}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-[var(--app-hint)]">
                        {agent.provider}
                        {agent.modelId ? ` / ${agent.modelId}` : ""}
                      </div>
                    </div>
                    <span className="shrink-0 rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--app-hint)]">
                      {agent.status}
                    </span>
                  </div>
                  {agent.role ? (
                    <div className="mt-2 line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed text-[var(--app-hint)]">
                      {agent.role}
                    </div>
                  ) : null}
                </div>
              ))
            ) : (
              <div className="rounded-lg border border-dashed border-[var(--app-border)] p-4 text-center text-xs text-[var(--app-hint)]">
                No agents in this room.
              </div>
            )}
          </OverlayScrollArea>
        </aside>
      </div>
    );
  }

  return chatSurface;
}
