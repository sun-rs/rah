import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionSummary } from "@rah/runtime-protocol";
import { Columns3, RefreshCcw, Rows3, X } from "lucide-react";
import {
  ConversationHeaderStateIconView,
  conversationMetaToneClassName,
} from "../ConversationMetaBadge";
import { resolveConversationHeaderState } from "../conversation-header-meta";
import {
  HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS,
  HEADER_SEGMENTED_BUTTON_BASE_CLASS,
  HEADER_SEGMENTED_BUTTON_INACTIVE_CLASS,
  HEADER_SEGMENTED_CONTROL_CLASS,
} from "../header-button-styles";
import {
  readRememberedSessionSideSurface,
  rememberSessionSideSurface,
  type SessionSideLayout,
} from "./session-side-state";

export type { SessionSideLayout } from "./session-side-state";

export type SessionSideDockItem = {
  id: string;
  summary: SessionSummary;
  unread?: boolean;
  onDiscard?: () => void;
  onRecreate?: () => void;
  content: ReactNode;
};

function SideDockSurface({ side }: { side: SessionSideDockItem }) {
  const state = side.summary.session.relationship?.sideState;
  const detail = side.summary.session.relationship?.sideStateDetail;
  const needsNotice = state === "expired" || state === "cleanup_failed";
  return (
    <div className="flex h-full min-h-0 flex-col">
      {needsNotice ? (
        <div
          className={`flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2 text-xs ${
            state === "cleanup_failed"
              ? "border-red-200 bg-red-50 text-red-700"
              : "border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-muted)]"
          }`}
          role="status"
        >
          <span className="min-w-0 truncate" title={detail}>
            {detail ??
              (state === "expired"
                ? "This Side expired in the provider."
                : "Side cleanup failed. Discard again to retry.")}
          </span>
          {state === "expired" && side.onRecreate ? (
            <button
              type="button"
              className="icon-click-feedback inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-[11px] font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
              onClick={side.onRecreate}
            >
              <RefreshCcw size={12} />
              New Side
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">{side.content}</div>
    </div>
  );
}

export function SessionSideDock(props: {
  dockId: string;
  main: ReactNode;
  sides: readonly SessionSideDockItem[];
  layout: SessionSideLayout;
  onLayoutChange: (layout: SessionSideLayout) => void;
}) {
  const [mobileSurfaceState, setMobileSurfaceState] = useState(() => ({
    dockId: props.dockId,
    surfaceId: readRememberedSessionSideSurface(
      typeof window === "undefined" ? undefined : window.localStorage,
      props.dockId,
    ),
  }));
  const mobileSurfaceId =
    mobileSurfaceState.dockId === props.dockId ? mobileSurfaceState.surfaceId : "main";
  const sideIdsKey = props.sides.map((side) => side.id).join("\u0000");
  const sideIdSet = useMemo(
    () => new Set(props.sides.map((side) => side.id)),
    [sideIdsKey],
  );

  useEffect(() => {
    if (mobileSurfaceState.dockId !== props.dockId) {
      setMobileSurfaceState({
        dockId: props.dockId,
        surfaceId: readRememberedSessionSideSurface(
          typeof window === "undefined" ? undefined : window.localStorage,
          props.dockId,
        ),
      });
      return;
    }
    if (mobileSurfaceId !== "main" && !sideIdSet.has(mobileSurfaceId)) {
      setMobileSurfaceState({ dockId: props.dockId, surfaceId: "main" });
      rememberSessionSideSurface(
        typeof window === "undefined" ? undefined : window.localStorage,
        props.dockId,
        "main",
      );
    }
  }, [mobileSurfaceId, mobileSurfaceState.dockId, props.dockId, sideIdSet]);

  const selectMobileSurface = (surfaceId: string) => {
    setMobileSurfaceState({ dockId: props.dockId, surfaceId });
    rememberSessionSideSurface(
      typeof window === "undefined" ? undefined : window.localStorage,
      props.dockId,
      surfaceId,
    );
  };

  if (props.sides.length === 0) {
    return <>{props.main}</>;
  }

  const toolbar = (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2">
      <span className="truncate text-[11px] font-medium text-[var(--app-hint)]">
        {props.sides.length} Side {props.sides.length === 1 ? "task" : "tasks"}
      </span>
      <div className={HEADER_SEGMENTED_CONTROL_CLASS}>
        <button
          type="button"
          className={`${HEADER_SEGMENTED_BUTTON_BASE_CLASS} ${
            props.layout === "columns"
              ? HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS
              : HEADER_SEGMENTED_BUTTON_INACTIVE_CLASS
          }`}
          onClick={() => props.onLayoutChange("columns")}
          aria-label="Arrange Side tasks in columns"
          aria-pressed={props.layout === "columns"}
          title="Columns"
        >
          <Columns3 size={14} />
        </button>
        <button
          type="button"
          className={`${HEADER_SEGMENTED_BUTTON_BASE_CLASS} ${
            props.layout === "stack"
              ? HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS
              : HEADER_SEGMENTED_BUTTON_INACTIVE_CLASS
          }`}
          onClick={() => props.onLayoutChange("stack")}
          aria-label="Arrange Side tasks in a vertical stack"
          aria-pressed={props.layout === "stack"}
          title="Stack"
        >
          <Rows3 size={14} />
        </button>
      </div>
    </div>
  );

  return (
    <div className="h-full min-h-0 min-w-0 bg-[var(--app-bg)]">
      <div className="hidden h-full min-h-0 min-w-0 lg:flex">
        <div className="min-w-0 flex-[1_1_60%]">{props.main}</div>
        <section
          className="flex min-h-0 min-w-[20rem] max-w-[44rem] flex-[0_1_40%] flex-col border-l border-[var(--app-border)]"
          aria-label="Side tasks"
        >
          {toolbar}
          {props.layout === "columns" ? (
            <div className="flex min-h-0 flex-1 overflow-x-auto">
              {props.sides.map((side) => (
                <div
                  key={side.id}
                  className="min-w-[20rem] flex-1 border-r border-[var(--app-border)] last:border-r-0"
                >
                  <SideDockSurface side={side} />
                </div>
              ))}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {props.sides.map((side) => (
                <div
                  key={side.id}
                  className="min-h-[28rem] border-b border-[var(--app-border)] last:border-b-0"
                >
                  <SideDockSurface side={side} />
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="flex h-full min-h-0 flex-col lg:hidden">
        <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2">
          <button
            type="button"
            className={`icon-click-feedback h-7 shrink-0 rounded-md px-3 text-xs font-medium transition-colors ${
              mobileSurfaceId === "main"
                ? HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS
                : HEADER_SEGMENTED_BUTTON_INACTIVE_CLASS
            }`}
            onClick={() => selectMobileSurface("main")}
          >
            Main
          </button>
          {props.sides.map((side, index) => {
            const state = resolveConversationHeaderState({
              status: side.summary.session.status,
              phase: side.summary.session.phase,
              ...(side.summary.session.relationship?.sideState
                ? { sideState: side.summary.session.relationship.sideState }
                : {}),
            });
            const title = side.summary.session.title ?? `Side ${index + 1}`;
            const selected = mobileSurfaceId === side.id;
            return (
              <div
                key={side.id}
                className={`flex h-7 max-w-[13rem] shrink-0 items-center overflow-hidden rounded-md transition-colors ${
                  selected
                    ? HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS
                    : HEADER_SEGMENTED_BUTTON_INACTIVE_CLASS
                }`}
              >
                <button
                  type="button"
                  className="icon-click-feedback flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2 pr-1 text-xs font-medium"
                  onClick={() => selectMobileSurface(side.id)}
                  aria-label={`Open ${title}, ${state.label}`}
                  title={`${title} · ${state.label}`}
                >
                  <span
                    className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${conversationMetaToneClassName(state.tone)}`}
                  >
                    <ConversationHeaderStateIconView icon={state.icon} />
                  </span>
                  <span className="min-w-0 truncate">{title}</span>
                  {side.unread ? (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500"
                      aria-label="Unread"
                    />
                  ) : null}
                </button>
                {side.onDiscard ? (
                  <button
                    type="button"
                    className="icon-click-feedback mr-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
                    onClick={() => {
                      if (selected) selectMobileSurface("main");
                      side.onDiscard?.();
                    }}
                    aria-label={`Discard ${title}`}
                    title={`Discard ${title}`}
                  >
                    <X size={13} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="min-h-0 flex-1">
          {mobileSurfaceId === "main"
            ? props.main
            : (() => {
                const side = props.sides.find((candidate) => candidate.id === mobileSurfaceId);
                return side ? <SideDockSurface side={side} /> : props.main;
              })()}
        </div>
      </div>
    </div>
  );
}
