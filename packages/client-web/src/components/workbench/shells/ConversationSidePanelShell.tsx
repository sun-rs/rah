import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Sheet } from "../../Sheet";

type ConversationSidePanelBreakpoint = "medium" | "wide";

const DEFAULT_PANEL_WIDTH_PX = 416;
const DEFAULT_PANEL_MIN_WIDTH_PX = 352;
const DEFAULT_PANEL_MAX_WIDTH_PX = 640;
const MIN_CONVERSATION_WIDTH_PX = 320;

function clampPanelWidth(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function storedPanelWidth(storageKey: string | undefined, fallback: number): number {
  if (!storageKey || typeof window === "undefined") {
    return fallback;
  }
  try {
    const value = Number.parseFloat(window.localStorage.getItem(storageKey) ?? "");
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function desktopClassNames(breakpoint: ConversationSidePanelBreakpoint): {
  aside: string;
  divider: string;
} {
  if (breakpoint === "wide") {
    return {
      aside: "hidden min-[900px]:flex",
      divider: "hidden min-[900px]:block",
    };
  }
  return {
    aside: "hidden min-[700px]:flex",
    divider: "hidden min-[700px]:block",
  };
}

export function ConversationSidePanelShell(props: {
  children: ReactNode;
  desktopOpen: boolean;
  showDesktop?: boolean;
  desktopBreakpoint?: ConversationSidePanelBreakpoint;
  desktopDefaultWidth?: number;
  desktopMinWidth?: number;
  desktopMaxWidth?: number;
  desktopStorageKey?: string;
  desktopClassName?: string;
  desktopStyle?: CSSProperties;
  contained?: boolean;
  mobileOpen?: boolean;
  onMobileOpenChange?: (open: boolean) => void;
  mobileTitle?: ReactNode;
  mobileModal?: boolean;
  mobileFullScreen?: boolean;
  mobileFloatingClose?: "panel" | "x" | false;
  mobileFloatingCloseLabel?: string;
}) {
  const breakpoint = props.desktopBreakpoint ?? "medium";
  const classNames = desktopClassNames(breakpoint);
  const minWidth = props.desktopMinWidth ?? DEFAULT_PANEL_MIN_WIDTH_PX;
  const maxWidth = props.desktopMaxWidth ?? DEFAULT_PANEL_MAX_WIDTH_PX;
  const defaultWidth = clampPanelWidth(
    props.desktopDefaultWidth ?? DEFAULT_PANEL_WIDTH_PX,
    minWidth,
    maxWidth,
  );
  const [desktopWidthPx, setDesktopWidthPx] = useState(() =>
    clampPanelWidth(storedPanelWidth(props.desktopStorageKey, defaultWidth), minWidth, maxWidth),
  );
  const [isResizing, setIsResizing] = useState(false);
  const asideRef = useRef<HTMLElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const showDesktop = props.showDesktop ?? true;
  const showMobile = props.mobileOpen !== undefined && props.onMobileOpenChange !== undefined;
  const mobileViewportClassName =
    breakpoint === "wide" ? "min-[900px]:!hidden" : "min-[700px]:!hidden";
  const containedDesktopClassNames =
    breakpoint === "wide"
      ? {
          aside: "max-[899px]:!hidden min-[900px]:!flex",
          divider: "max-[899px]:!hidden min-[900px]:!block",
        }
      : {
          aside: "max-[699px]:!hidden min-[700px]:!flex",
          divider: "max-[699px]:!hidden min-[700px]:!block",
        };

  const persistWidth = useCallback((width: number) => {
    if (!props.desktopStorageKey || typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(props.desktopStorageKey, String(Math.round(width)));
    } catch {
      // Storage can be unavailable in private browsing; resizing still works for this page.
    }
  }, [props.desktopStorageKey]);

  const stopResize = useCallback(() => {
    resizeCleanupRef.current?.();
    resizeCleanupRef.current = null;
    setIsResizing(false);
  }, []);

  useEffect(() => stopResize, [stopResize]);

  const startResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !props.desktopOpen) {
      return;
    }
    event.preventDefault();
    stopResize();
    const startX = event.clientX;
    const startWidth = desktopWidthPx;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    setIsResizing(true);
    let frameId: number | null = null;
    let latestClientX: number | null = null;
    let latestWidth = startWidth;

    const applyPointerPosition = (clientX: number) => {
      const parentWidth = asideRef.current?.parentElement?.getBoundingClientRect().width ?? 0;
      const availableMax = Math.max(0, parentWidth - MIN_CONVERSATION_WIDTH_PX);
      const effectiveMax = Math.min(maxWidth, availableMax);
      const effectiveMin = Math.min(minWidth, effectiveMax);
      latestWidth = clampPanelWidth(
        startWidth + startX - clientX,
        effectiveMin,
        effectiveMax,
      );
      setDesktopWidthPx(latestWidth);
    };
    const flushPointerPosition = () => {
      frameId = null;
      if (latestClientX !== null) {
        applyPointerPosition(latestClientX);
      }
    };
    const onPointerMove = (moveEvent: PointerEvent) => {
      latestClientX = moveEvent.clientX;
      if (frameId === null) {
        frameId = window.requestAnimationFrame(flushPointerPosition);
      }
    };
    function onPointerUp(event: PointerEvent) {
      latestClientX = event.clientX;
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }
      flushPointerPosition();
      cleanup();
      resizeCleanupRef.current = null;
      setIsResizing(false);
      persistWidth(latestWidth);
    }
    const cleanup = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      document.body.style.userSelect = previousUserSelect;
    };
    resizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }, [desktopWidthPx, maxWidth, minWidth, persistWidth, props.desktopOpen, stopResize]);

  const resizeWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? 16 : -16;
    setDesktopWidthPx((current) => {
      const parentWidth = asideRef.current?.parentElement?.getBoundingClientRect().width ?? 0;
      const availableMax = Math.max(0, parentWidth - MIN_CONVERSATION_WIDTH_PX);
      const effectiveMax = Math.min(maxWidth, availableMax);
      const effectiveMin = Math.min(minWidth, effectiveMax);
      const next = clampPanelWidth(current + delta, effectiveMin, effectiveMax);
      persistWidth(next);
      return next;
    });
  }, [maxWidth, minWidth, persistWidth]);

  const desktopWidth = `${desktopWidthPx}px`;

  const mobileSheet = showMobile ? (
    <Sheet
      open={props.mobileOpen ?? false}
      onOpenChange={props.onMobileOpenChange!}
      side="right"
      title={props.mobileTitle ?? "Details"}
      hideHeader
      viewportClassName={mobileViewportClassName}
      {...(props.mobileModal !== undefined ? { modal: props.mobileModal } : {})}
      fullScreen={props.mobileFullScreen === true}
      {...(props.mobileFloatingClose === false
        ? {}
        : {
            floatingClose: props.mobileFloatingClose ?? "panel",
            floatingCloseLabel: props.mobileFloatingCloseLabel ?? "Hide panel",
          })}
    >
      {props.children}
    </Sheet>
  ) : null;

  if (props.contained) {
    return (
      <>
        {showDesktop && props.desktopOpen ? (
          <>
            <div
              className={`inspector-divider conversation-contained-panel-divider ${
                showMobile ? containedDesktopClassNames.divider : ""
              } ${isResizing ? "dragging" : ""}`}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize details panel"
              aria-valuemin={minWidth}
              aria-valuemax={maxWidth}
              aria-valuenow={Math.round(desktopWidthPx)}
              tabIndex={0}
              onPointerDown={startResize}
              onKeyDown={resizeWithKeyboard}
            />
            <aside
              ref={asideRef}
              className={`conversation-contained-panel relative shrink-0 flex-col overflow-visible bg-transparent ${
                showMobile ? containedDesktopClassNames.aside : ""
              } ${
                isResizing ? "" : "transition-[width] duration-150 ease-out"
              } ${props.desktopClassName ?? ""}`}
              style={{
                "--conversation-contained-panel-width": desktopWidth,
                ...props.desktopStyle,
              } as CSSProperties}
            >
              <div className="h-full min-w-0 overflow-hidden bg-[var(--app-subtle-bg)]">
                {props.children}
              </div>
            </aside>
          </>
        ) : null}
        {mobileSheet}
      </>
    );
  }

  return (
    <>
      {showDesktop ? (
        <>
          {props.desktopOpen ? (
            <div
              className={`inspector-divider ${isResizing ? "dragging" : ""} ${classNames.divider}`}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize details panel"
              aria-valuemin={minWidth}
              aria-valuemax={maxWidth}
              aria-valuenow={Math.round(desktopWidthPx)}
              tabIndex={0}
              onPointerDown={startResize}
              onKeyDown={resizeWithKeyboard}
            />
          ) : null}
          <aside
            ref={asideRef}
            className={`${classNames.aside} relative shrink-0 flex-col overflow-visible bg-transparent ${
              isResizing ? "" : "transition-[width] duration-150 ease-out"
            } ${props.desktopClassName ?? ""}`}
            style={{
              width: props.desktopOpen ? desktopWidth : 0,
              maxWidth: props.desktopOpen
                ? `max(0px, calc(100% - ${MIN_CONVERSATION_WIDTH_PX}px))`
                : 0,
              ...props.desktopStyle,
            }}
          >
            <div className="h-full min-w-0 overflow-hidden bg-[var(--app-subtle-bg)]">
              {props.desktopOpen ? props.children : null}
            </div>
          </aside>
        </>
      ) : null}

      {mobileSheet}
    </>
  );
}
