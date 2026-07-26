import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { SessionSummary } from "@rah/runtime-protocol";
import { X } from "lucide-react";
import {
  ConversationHeaderStateIconView,
  conversationMetaToneClassName,
} from "../ConversationMetaBadge";
import { resolveConversationHeaderState } from "../conversation-header-meta";
import {
  HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS,
  HEADER_SEGMENTED_BUTTON_INACTIVE_CLASS,
} from "../header-button-styles";
import { MobileSidebarToggleButton } from "../shells/MobileSidebarToggleButton";
import {
  readRememberedSessionSideSizing,
  readRememberedSessionSideSurface,
  rememberSessionSideSizing,
  rememberSessionSideSurface,
  type SessionSideLayout,
  type SessionSideSizing,
} from "./session-side-state";

export type { SessionSideLayout } from "./session-side-state";

export type SessionSideDockItem = {
  id: string;
  summary: SessionSummary;
  unread?: boolean;
  onDiscard?: () => void;
  content: ReactNode;
};

function SideDockSurface({ side }: { side: SessionSideDockItem }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">{side.content}</div>
    </div>
  );
}

const DEFAULT_MAIN_SHARE = 0.6;
const MIN_MAIN_SURFACE_PX = 320;
const MIN_SIDE_SURFACE_PX = 240;

type SideDockSizingState = SessionSideSizing & { dockId: string };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function defaultSizing(dockId: string): SideDockSizingState {
  return { dockId, mainShare: DEFAULT_MAIN_SHARE, sideShares: {} };
}

function readSizing(dockId: string): SideDockSizingState {
  const remembered = readRememberedSessionSideSizing(
    typeof window === "undefined" ? undefined : window.localStorage,
    dockId,
  );
  return { dockId, ...(remembered ?? defaultSizing(dockId)) };
}

function normalizeSideShares(
  sides: readonly SessionSideDockItem[],
  remembered: Record<string, number>,
): Record<string, number> {
  const weights = sides.map((side) => {
    const value = remembered[side.id];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
  });
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  return Object.fromEntries(sides.map((side, index) => [side.id, weights[index]! / total]));
}

function SideResizeHandle(props: {
  orientation: "vertical" | "horizontal";
  label: string;
  resizing: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyboardResize: (direction: -1 | 1) => void;
}) {
  const vertical = props.orientation === "vertical";
  return (
    <div
      className={`group relative z-30 shrink-0 touch-none ${
        vertical ? "-mx-1 w-2 cursor-col-resize" : "-my-1 h-2 cursor-row-resize"
      }`}
      role="separator"
      aria-orientation={props.orientation}
      aria-label={props.label}
      tabIndex={0}
      onPointerDown={props.onPointerDown}
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        const backwardKey = vertical ? "ArrowLeft" : "ArrowUp";
        const forwardKey = vertical ? "ArrowRight" : "ArrowDown";
        if (event.key !== backwardKey && event.key !== forwardKey) return;
        event.preventDefault();
        props.onKeyboardResize(event.key === backwardKey ? -1 : 1);
      }}
    >
      <span
        className={`pointer-events-none absolute bg-[var(--app-border)] transition-colors group-hover:bg-[var(--app-hint)] ${
          props.resizing ? "!bg-[var(--app-hint)]" : ""
        } ${
          vertical
            ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
            : "inset-x-0 top-1/2 h-px -translate-y-1/2"
        }`}
        aria-hidden="true"
      />
    </div>
  );
}

export function SessionSideDock(props: {
  dockId: string;
  main: ReactNode;
  sides: readonly SessionSideDockItem[];
  layout: SessionSideLayout;
  showMobileSidebarControl?: boolean;
  onOpenMobileSidebar?: () => void;
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
  const [sizingState, setSizingState] = useState<SideDockSizingState>(() =>
    readSizing(props.dockId),
  );
  const sizingRef = useRef(sizingState);
  const desktopRootRef = useRef<HTMLDivElement | null>(null);
  const sideRegionRef = useRef<HTMLElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [activeResizeId, setActiveResizeId] = useState<string | null>(null);

  useEffect(() => {
    if (sizingState.dockId === props.dockId) return;
    const next = readSizing(props.dockId);
    sizingRef.current = next;
    setSizingState(next);
  }, [props.dockId, sizingState.dockId]);

  const effectiveSizing =
    sizingState.dockId === props.dockId ? sizingState : defaultSizing(props.dockId);
  const mainShare = clamp(effectiveSizing.mainShare, 0.2, 0.8);
  const sideShares = useMemo(
    () => normalizeSideShares(props.sides, effectiveSizing.sideShares),
    [effectiveSizing.sideShares, sideIdsKey],
  );

  const updateSizing = useCallback((sizing: SessionSideSizing) => {
    const next = { dockId: props.dockId, ...sizing };
    sizingRef.current = next;
    setSizingState(next);
  }, [props.dockId]);

  const stopResize = useCallback(() => {
    resizeCleanupRef.current?.();
    resizeCleanupRef.current = null;
    setActiveResizeId(null);
  }, []);

  useEffect(() => stopResize, [stopResize]);

  const beginResize = useCallback((args: {
    event: ReactPointerEvent<HTMLDivElement>;
    resizeId: string;
    cursor: "col-resize" | "row-resize";
    onMove: (clientX: number, clientY: number) => void;
  }) => {
    if (args.event.button !== 0) return;
    args.event.preventDefault();
    stopResize();
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = args.cursor;
    setActiveResizeId(args.resizeId);
    let frameId: number | null = null;
    let latestPoint: { x: number; y: number } | null = null;

    const flush = () => {
      frameId = null;
      if (latestPoint) args.onMove(latestPoint.x, latestPoint.y);
    };
    const onPointerMove = (moveEvent: PointerEvent) => {
      latestPoint = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (frameId === null) frameId = window.requestAnimationFrame(flush);
    };
    const cleanup = () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
    };
    const onPointerUp = () => {
      if (latestPoint) args.onMove(latestPoint.x, latestPoint.y);
      cleanup();
      resizeCleanupRef.current = null;
      setActiveResizeId(null);
      const current = sizingRef.current;
      if (current.dockId === props.dockId) {
        rememberSessionSideSizing(window.localStorage, props.dockId, current);
      }
    };
    resizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    window.addEventListener("pointercancel", onPointerUp, { once: true });
  }, [props.dockId, stopResize]);

  const startMainResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = desktopRootRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const startX = event.clientX;
    const startShare = mainShare;
    const startSideShares = sideShares;
    const minMainShare = Math.min(0.48, MIN_MAIN_SURFACE_PX / rect.width);
    const minSideShare = Math.min(0.48, MIN_SIDE_SURFACE_PX / rect.width);
    beginResize({
      event,
      resizeId: "main",
      cursor: "col-resize",
      onMove: (clientX) => {
        updateSizing({
          mainShare: clamp(
            startShare + (clientX - startX) / rect.width,
            minMainShare,
            1 - minSideShare,
          ),
          sideShares: startSideShares,
        });
      },
    });
  }, [beginResize, mainShare, sideShares, updateSizing]);

  const resizeMainWithKeyboard = useCallback((direction: -1 | 1) => {
    const width = desktopRootRef.current?.getBoundingClientRect().width ?? 0;
    if (width <= 0) return;
    const minMainShare = Math.min(0.48, MIN_MAIN_SURFACE_PX / width);
    const minSideShare = Math.min(0.48, MIN_SIDE_SURFACE_PX / width);
    const next = {
      mainShare: clamp(mainShare + direction * (24 / width), minMainShare, 1 - minSideShare),
      sideShares,
    };
    updateSizing(next);
    rememberSessionSideSizing(window.localStorage, props.dockId, next);
  }, [mainShare, props.dockId, sideShares, updateSizing]);

  const startSideResize = useCallback((
    firstId: string,
    secondId: string,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const rect = sideRegionRef.current?.getBoundingClientRect();
    if (!rect) return;
    const axisSize = props.layout === "columns" ? rect.width : rect.height;
    if (axisSize <= 0) return;
    const startCoordinate = props.layout === "columns" ? event.clientX : event.clientY;
    const startShares = sideShares;
    const firstShare = startShares[firstId] ?? 0;
    const secondShare = startShares[secondId] ?? 0;
    const pairShare = firstShare + secondShare;
    const minShare = Math.min(pairShare / 2, MIN_SIDE_SURFACE_PX / axisSize);
    beginResize({
      event,
      resizeId: `${firstId}:${secondId}`,
      cursor: props.layout === "columns" ? "col-resize" : "row-resize",
      onMove: (clientX, clientY) => {
        const coordinate = props.layout === "columns" ? clientX : clientY;
        const nextFirst = clamp(
          firstShare + (coordinate - startCoordinate) / axisSize,
          minShare,
          pairShare - minShare,
        );
        updateSizing({
          mainShare,
          sideShares: {
            ...startShares,
            [firstId]: nextFirst,
            [secondId]: pairShare - nextFirst,
          },
        });
      },
    });
  }, [beginResize, mainShare, props.layout, sideShares, updateSizing]);

  const resizeSidesWithKeyboard = useCallback((
    firstId: string,
    secondId: string,
    direction: -1 | 1,
  ) => {
    const rect = sideRegionRef.current?.getBoundingClientRect();
    if (!rect) return;
    const axisSize = props.layout === "columns" ? rect.width : rect.height;
    if (axisSize <= 0) return;
    const firstShare = sideShares[firstId] ?? 0;
    const secondShare = sideShares[secondId] ?? 0;
    const pairShare = firstShare + secondShare;
    const minShare = Math.min(pairShare / 2, MIN_SIDE_SURFACE_PX / axisSize);
    const nextFirst = clamp(
      firstShare + direction * (24 / axisSize),
      minShare,
      pairShare - minShare,
    );
    const next = {
      mainShare,
      sideShares: {
        ...sideShares,
        [firstId]: nextFirst,
        [secondId]: pairShare - nextFirst,
      },
    };
    updateSizing(next);
    rememberSessionSideSizing(window.localStorage, props.dockId, next);
  }, [mainShare, props.dockId, props.layout, sideShares, updateSizing]);

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

  return (
    <div className="isolate h-full min-h-0 min-w-0 overflow-hidden bg-[var(--app-bg)]">
      <div ref={desktopRootRef} className="hidden h-full min-h-0 min-w-0 lg:flex">
        <div
          className="min-w-0 shrink-0 overflow-hidden"
          style={{ flexBasis: `${mainShare * 100}%` }}
        >
          {props.main}
        </div>
        <SideResizeHandle
          orientation="vertical"
          label="Resize main task and Side tasks"
          resizing={activeResizeId === "main"}
          onPointerDown={startMainResize}
          onKeyboardResize={resizeMainWithKeyboard}
        />
        <section
          ref={sideRegionRef}
          className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
          aria-label="Side tasks"
        >
          <div
            className={`flex h-full min-h-0 min-w-0 flex-1 overflow-hidden ${
              props.layout === "columns" ? "flex-row" : "flex-col"
            }`}
          >
            {props.sides.map((side, index) => {
              const nextSide = props.sides[index + 1];
              return (
                <div key={side.id} className="contents">
                  <div
                    className="min-h-0 min-w-0 shrink-0 overflow-hidden"
                    style={{ flexBasis: `${(sideShares[side.id] ?? 0) * 100}%` }}
                  >
                    <SideDockSurface side={side} />
                  </div>
                  {nextSide ? (
                    <SideResizeHandle
                      orientation={props.layout === "columns" ? "vertical" : "horizontal"}
                      label={`Resize ${side.summary.session.title ?? "Side task"} and ${nextSide.summary.session.title ?? "Side task"}`}
                      resizing={activeResizeId === `${side.id}:${nextSide.id}`}
                      onPointerDown={(event) => startSideResize(side.id, nextSide.id, event)}
                      onKeyboardResize={(direction) =>
                        resizeSidesWithKeyboard(side.id, nextSide.id, direction)
                      }
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      </div>

      <div className="flex h-full min-h-0 flex-col lg:hidden">
        <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2">
          {props.showMobileSidebarControl && props.onOpenMobileSidebar ? (
            <MobileSidebarToggleButton
              className="md:!hidden"
              onOpen={props.onOpenMobileSidebar}
            />
          ) : null}
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
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
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
