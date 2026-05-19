import type { CouncilSnapshot } from "@rah/runtime-protocol";
import { MessageSquareText } from "lucide-react";
import { chooseChatListSubtitle, compactChatListText } from "../chat-list-display";
import { ChatBrowserRow } from "../components/ChatBrowserRow";
import { formatRelativeTime, type RelativeTimeFormat } from "../session-browser";
import { usePwaDisplayMode } from "../hooks/usePwaDisplayMode";
import { councilActivityAt, councilActivityMs } from "./council-activity";

type CouncilMessage = CouncilSnapshot["messages"][number];

export function isCouncilHistory(council: CouncilSnapshot): boolean {
  return council.status === "stopped";
}

export function defaultRunningCouncilId(councils: readonly CouncilSnapshot[]): string | null {
  const runningCouncils = councils.filter((council) => !isCouncilHistory(council));
  const runningCouncilsWithMessages = runningCouncils.filter((council) => council.messages.length > 0);
  const candidates = runningCouncilsWithMessages.length > 0 ? runningCouncilsWithMessages : runningCouncils;
  return candidates
    .sort((left, right) => councilActivityMs(right) - councilActivityMs(left))[0]?.id ?? null;
}

export function reconcileCouncilSelection(
  currentCouncilId: string | null,
  councils: readonly CouncilSnapshot[],
  options?: { allowRunningDefault?: boolean | undefined },
): string | null {
  if (currentCouncilId && councils.some((council) => council.id === currentCouncilId)) {
    return currentCouncilId;
  }
  if (!currentCouncilId && options?.allowRunningDefault) {
    return defaultRunningCouncilId(councils);
  }
  return null;
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

export function councilLineLabel(council: CouncilSnapshot): string {
  return formatCouncilCount(council.meta?.messageCount ?? council.messageWindow?.total ?? council.messages.length, "lines");
}

export function councilLineTitle(council: CouncilSnapshot): string {
  const count = council.meta?.messageCount ?? council.messageWindow?.total ?? council.messages.length;
  return `${count.toLocaleString()} Council message log lines`;
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

function textFromParts(parts: CouncilMessage["parts"]): string {
  return parts
    .map((part) => {
      if (part.kind === "text") {
        return part.text;
      }
      return JSON.stringify(part.data) ?? String(part.data);
    })
    .join("\n");
}

function firstCouncilMessageByRole(
  council: CouncilSnapshot,
  role: "user" | "agent",
): CouncilMessage | null {
  return council.messages.find(
    (message) => message.role === role && compactChatListText(textFromParts(message.parts)),
  ) ?? null;
}

export function councilConversationSubtitle(council: CouncilSnapshot): string | null {
  const firstUser = firstCouncilMessageByRole(council, "user");
  const firstAgent = firstCouncilMessageByRole(council, "agent");
  const firstUserSummary = council.meta?.firstUserMessage;
  const firstAgentSummary = council.meta?.firstAgentMessage;
  return chooseChatListSubtitle(council.title, [
    firstUserSummary
      ? { label: actorLabel(council, firstUserSummary.actorId), text: firstUserSummary.text }
      : firstUser
        ? { label: actorLabel(council, firstUser.actorId), text: textFromParts(firstUser.parts) }
        : {},
    firstAgentSummary
      ? { label: actorLabel(council, firstAgentSummary.actorId), text: firstAgentSummary.text }
      : firstAgent
        ? { label: actorLabel(council, firstAgent.actorId), text: textFromParts(firstAgent.parts) }
      : {},
  ]);
}

export function councilMatchesQuery(council: CouncilSnapshot, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) {
    return true;
  }
  const subtitle = councilConversationSubtitle(council);
  return (
    council.title.toLowerCase().includes(q) ||
    council.id.toLowerCase().includes(q) ||
    council.workspace.toLowerCase().includes(q) ||
    (subtitle ?? "").toLowerCase().includes(q) ||
    council.status.toLowerCase().includes(q) ||
    (council.phase ?? "").toLowerCase().includes(q) ||
    council.agents.some((agent) =>
      agent.label.toLowerCase().includes(q) ||
      agent.id.toLowerCase().includes(q) ||
      agent.provider.toLowerCase().includes(q),
    )
  );
}

export function splitCouncils(
  councils: readonly CouncilSnapshot[],
  query = "",
): { activeCouncils: CouncilSnapshot[]; historyCouncils: CouncilSnapshot[] } {
  const filtered = councils.filter((council) => councilMatchesQuery(council, query));
  return {
    activeCouncils: filtered
      .filter((council) => !isCouncilHistory(council))
      .sort((left, right) => councilActivityMs(right) - councilActivityMs(left)),
    historyCouncils: filtered
      .filter((council) => isCouncilHistory(council))
      .sort((left, right) => councilActivityMs(right) - councilActivityMs(left)),
  };
}

function CouncilRow(props: {
  council: CouncilSnapshot;
  selected: boolean;
  variant: "running" | "history";
  loading?: boolean | undefined;
  relativeTimeFormat: RelativeTimeFormat;
  onOpenCouncil: (council: CouncilSnapshot) => void;
  onRequestDeleteCouncil?: ((council: CouncilSnapshot) => void) | undefined;
}) {
  const canDelete = props.variant === "history" && Boolean(props.onRequestDeleteCouncil);

  return (
    <ChatBrowserRow
      title={props.council.title}
      subtitle={councilConversationSubtitle(props.council)}
      detail={props.council.workspace}
      leading={<MessageSquareText size={17} className="text-[var(--app-hint)]" />}
      selected={props.selected}
      badge={
        props.variant === "running"
          ? { label: "Running", tone: "running" }
          : { label: "Stopped" }
      }
      meta={{
        label: councilLineLabel(props.council),
        title: councilLineTitle(props.council),
      }}
      timeLabel={formatRelativeTime(councilActivityAt(props.council), {
        format: props.relativeTimeFormat,
      })}
      onOpen={() => props.onOpenCouncil(props.council)}
      onDelete={
        canDelete
          ? () => {
              props.onRequestDeleteCouncil?.(props.council);
            }
          : undefined
      }
      deleteDisabled={props.loading}
      deleteLabel="Delete Council"
    />
  );
}

export function CouncilsBrowser(props: {
  councils: readonly CouncilSnapshot[];
  selectedCouncilId?: string | null | undefined;
  query?: string | undefined;
  loading?: boolean | undefined;
  onOpenCouncil: (council: CouncilSnapshot) => void;
  onShowCouncilInfo?: ((council: CouncilSnapshot) => void) | undefined;
  onRenameCouncil?: ((council: CouncilSnapshot) => void) | undefined;
  onRequestDeleteCouncil?: ((council: CouncilSnapshot) => void) | undefined;
}) {
  const { activeCouncils, historyCouncils } = splitCouncils(props.councils, props.query ?? "");
  const queryActive = Boolean(props.query?.trim());
  const relativeTimeFormat: RelativeTimeFormat = usePwaDisplayMode() ? "compact" : "long";

  return (
    <div className="space-y-4">
      <section className="space-y-1.5">
        <div className="flex items-center justify-between px-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--app-hint)]">
            Running
          </div>
          <span className="rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[10px] font-semibold text-[var(--app-hint)]">
            {activeCouncils.length}
          </span>
        </div>
        {activeCouncils.length > 0 ? activeCouncils.map((council) => (
          <CouncilRow
            key={council.id}
            council={council}
            selected={props.selectedCouncilId === council.id}
            variant="running"
            loading={props.loading}
            relativeTimeFormat={relativeTimeFormat}
            onOpenCouncil={props.onOpenCouncil}
          />
        )) : (
          <div className="rounded-xl border border-dashed border-[var(--app-border)] p-4 text-center text-sm text-[var(--app-hint)]">
            {queryActive ? "No matching running Councils." : "No running Councils."}
          </div>
        )}
      </section>

      <section className="space-y-1.5">
        <div className="flex items-center justify-between px-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--app-hint)]">
            Stopped
          </div>
          <span className="rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[10px] font-semibold text-[var(--app-hint)]">
            {historyCouncils.length}
          </span>
        </div>
        {historyCouncils.length > 0 ? historyCouncils.map((council) => (
          <CouncilRow
            key={council.id}
            council={council}
            selected={props.selectedCouncilId === council.id}
            variant="history"
            loading={props.loading}
            relativeTimeFormat={relativeTimeFormat}
            onOpenCouncil={props.onOpenCouncil}
            onRequestDeleteCouncil={props.onRequestDeleteCouncil}
          />
        )) : (
          <div className="rounded-xl border border-dashed border-[var(--app-border)] p-4 text-center text-sm text-[var(--app-hint)]">
            {queryActive ? "No matching stopped Councils." : "No stopped Councils yet."}
          </div>
        )}
      </section>
    </div>
  );
}
