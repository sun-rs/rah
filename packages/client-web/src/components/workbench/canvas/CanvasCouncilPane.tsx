import { MessageSquareText, UsersRound } from "lucide-react";
import type { CouncilSnapshot } from "@rah/runtime-protocol";
import type { ObjectPaneVariant } from "../../../object-pane-variant";
import { OverlayScrollArea } from "../../OverlayScrollArea";

function textFromParts(parts: CouncilSnapshot["messages"][number]["parts"]): string {
  return parts
    .map((part) => part.kind === "text" ? part.text : JSON.stringify(part.data))
    .join("\n");
}

function actorLabel(council: CouncilSnapshot, actorId: string): string {
  if (actorId === "user") {
    return "You";
  }
  if (actorId === "system") {
    return "System";
  }
  return council.agents.find((agent) => agent.id === actorId)?.label ?? actorId;
}

function councilStatusLabel(council: CouncilSnapshot): string {
  if (council.status === "stopped") {
    return council.phase === "failed" ? "Stopped / Failed" : "Stopped";
  }
  if (council.phase === "starting") {
    return "Running / Starting";
  }
  if (council.phase === "working") {
    return "Running / Working";
  }
  if (council.phase === "waiting_permission") {
    return "Running / Waiting permission";
  }
  return "Running";
}

export function CanvasCouncilPane(props: {
  variant: ObjectPaneVariant;
  council: CouncilSnapshot | null;
  onOpenFullCouncil: (councilId: string) => void;
}) {
  if (!props.council) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6 text-center">
        <div>
          <div className="text-sm font-medium text-[var(--app-fg)]">Council unavailable</div>
          <div className="mt-1 text-xs text-[var(--app-hint)]">
            The Council no longer exists or has not loaded yet.
          </div>
        </div>
      </div>
    );
  }

  const latestMessages = props.council.messages.slice(-80);
  const statusLabel = councilStatusLabel(props.council);
  const running = props.council.status === "running";

  const chatSurface = (
    <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
      <div className="shrink-0 border-b border-[var(--app-border)] px-3 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-[var(--app-fg)]">
              {props.council.title}
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
                {props.council.agents.length} agents
              </span>
              <span className="inline-flex items-center gap-1">
                <MessageSquareText size={12} />
                {props.council.messages.length} messages
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => props.onOpenFullCouncil(props.council!.id)}
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
        scrollAriaLabel="Council messages"
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
                    {actorLabel(props.council!, message.actorId)}
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
            No Council messages yet.
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
                {props.council.agents.length} Council participants
              </div>
            </div>
          </div>
          <OverlayScrollArea
            className="min-h-0 flex-1"
            viewportClassName="h-full"
            contentClassName="space-y-2 p-3"
            scrollAriaLabel="Council agents"
          >
            {props.council.agents.length > 0 ? (
              props.council.agents.map((agent) => (
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
                No agents in this Council.
              </div>
            )}
          </OverlayScrollArea>
        </aside>
      </div>
    );
  }

  return chatSurface;
}
