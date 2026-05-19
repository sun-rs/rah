import type { CouncilRoomSnapshot } from "@rah/runtime-protocol";
import { MessageSquareText } from "lucide-react";
import { ChatBrowserRow } from "../components/ChatBrowserRow";

export function isCouncilHistoryRoom(room: CouncilRoomSnapshot): boolean {
  return room.room.status === "stopped";
}

export function councilRoomActivityMs(room: CouncilRoomSnapshot): number {
  const lastMessage = room.messages.at(-1);
  return Date.parse(lastMessage?.createdAt ?? room.room.updatedAt ?? room.room.createdAt) || 0;
}

export function defaultRunningCouncilRoomId(rooms: readonly CouncilRoomSnapshot[]): string | null {
  return rooms
    .filter((room) => !isCouncilHistoryRoom(room))
    .sort((left, right) => councilRoomActivityMs(right) - councilRoomActivityMs(left))[0]?.room.id ?? null;
}

export function formatCouncilCount(value: number, unit: string): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}m ${unit}`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k ${unit}`;
  }
  return `${value} ${unit}`;
}

export function councilRoomLineLabel(room: CouncilRoomSnapshot): string {
  return formatCouncilCount(room.messages.length, "lines");
}

export function councilRoomLineTitle(room: CouncilRoomSnapshot): string {
  return `${room.messages.length.toLocaleString()} room message log lines`;
}

export function councilRoomMatchesQuery(room: CouncilRoomSnapshot, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) {
    return true;
  }
  return (
    room.room.title.toLowerCase().includes(q) ||
    room.room.id.toLowerCase().includes(q) ||
    room.room.workspace.toLowerCase().includes(q) ||
    room.room.status.toLowerCase().includes(q) ||
    (room.room.phase ?? "").toLowerCase().includes(q) ||
    room.agents.some((agent) =>
      agent.label.toLowerCase().includes(q) ||
      agent.id.toLowerCase().includes(q) ||
      agent.provider.toLowerCase().includes(q),
    )
  );
}

export function splitCouncilRooms(
  rooms: readonly CouncilRoomSnapshot[],
  query = "",
): { activeRooms: CouncilRoomSnapshot[]; historyRooms: CouncilRoomSnapshot[] } {
  const filtered = rooms.filter((room) => councilRoomMatchesQuery(room, query));
  return {
    activeRooms: filtered
      .filter((room) => !isCouncilHistoryRoom(room))
      .sort((left, right) => councilRoomActivityMs(right) - councilRoomActivityMs(left)),
    historyRooms: filtered
      .filter((room) => isCouncilHistoryRoom(room))
      .sort((left, right) => councilRoomActivityMs(right) - councilRoomActivityMs(left)),
  };
}

function CouncilRoomRow(props: {
  room: CouncilRoomSnapshot;
  selected: boolean;
  variant: "running" | "history";
  loading?: boolean | undefined;
  onOpenRoom: (room: CouncilRoomSnapshot) => void;
  onShowRoomInfo?: ((room: CouncilRoomSnapshot) => void) | undefined;
  onRequestDeleteRoom?: ((room: CouncilRoomSnapshot) => void) | undefined;
}) {
  return (
    <ChatBrowserRow
      title={props.room.room.title}
      detail={props.room.room.workspace}
      leading={<MessageSquareText size={17} className="text-[var(--app-hint)]" />}
      selected={props.selected}
      badge={
        props.variant === "running"
          ? { label: "Running", tone: "running" }
          : { label: "Stopped" }
      }
      meta={{
        label: councilRoomLineLabel(props.room),
        title: councilRoomLineTitle(props.room),
      }}
      onOpen={() => props.onOpenRoom(props.room)}
      onInfo={props.onShowRoomInfo ? () => props.onShowRoomInfo?.(props.room) : undefined}
      infoLabel={`Show info for ${props.room.room.title}`}
      onDelete={
        props.variant === "history" && props.onRequestDeleteRoom
          ? () => props.onRequestDeleteRoom?.(props.room)
          : undefined
      }
      deleteLabel={`Delete ${props.room.room.title}`}
      deleteDisabled={props.loading}
    />
  );
}

export function CouncilRoomsBrowser(props: {
  rooms: readonly CouncilRoomSnapshot[];
  selectedRoomId?: string | null | undefined;
  query?: string | undefined;
  loading?: boolean | undefined;
  onOpenRoom: (room: CouncilRoomSnapshot) => void;
  onShowRoomInfo?: ((room: CouncilRoomSnapshot) => void) | undefined;
  onRequestDeleteRoom?: ((room: CouncilRoomSnapshot) => void) | undefined;
}) {
  const { activeRooms, historyRooms } = splitCouncilRooms(props.rooms, props.query ?? "");
  const queryActive = Boolean(props.query?.trim());

  return (
    <div className="space-y-4">
      <section className="space-y-1.5">
        <div className="flex items-center justify-between px-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--app-hint)]">
            Running
          </div>
          <span className="rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[10px] font-semibold text-[var(--app-hint)]">
            {activeRooms.length}
          </span>
        </div>
        {activeRooms.length > 0 ? activeRooms.map((room) => (
          <CouncilRoomRow
            key={room.room.id}
            room={room}
            selected={props.selectedRoomId === room.room.id}
            variant="running"
            loading={props.loading}
            onOpenRoom={props.onOpenRoom}
            onShowRoomInfo={props.onShowRoomInfo}
          />
        )) : (
          <div className="rounded-xl border border-dashed border-[var(--app-border)] p-4 text-center text-sm text-[var(--app-hint)]">
            {queryActive ? "No matching running rooms." : "No running rooms."}
          </div>
        )}
      </section>

      <section className="space-y-1.5">
        <div className="flex items-center justify-between px-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--app-hint)]">
            Stopped
          </div>
          <span className="rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[10px] font-semibold text-[var(--app-hint)]">
            {historyRooms.length}
          </span>
        </div>
        {historyRooms.length > 0 ? historyRooms.map((room) => (
          <CouncilRoomRow
            key={room.room.id}
            room={room}
            selected={props.selectedRoomId === room.room.id}
            variant="history"
            loading={props.loading}
            onOpenRoom={props.onOpenRoom}
            onShowRoomInfo={props.onShowRoomInfo}
            onRequestDeleteRoom={props.onRequestDeleteRoom}
          />
        )) : (
          <div className="rounded-xl border border-dashed border-[var(--app-border)] p-4 text-center text-sm text-[var(--app-hint)]">
            {queryActive ? "No matching stopped rooms." : "No stopped rooms yet."}
          </div>
        )}
      </section>
    </div>
  );
}
