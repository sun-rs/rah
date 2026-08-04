import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  INITIAL_SIDEBAR_SESSION_TOOLTIP_STATE,
  reduceSidebarSessionTooltipState,
} from "./sidebar-session-tooltip-state";

export const SIDEBAR_SESSION_TOOLTIP_HOVER_DELAY_MS = 160;
export const SIDEBAR_SESSION_TOOLTIP_KEY_ATTRIBUTE =
  "data-sidebar-session-tooltip-key";

export type SidebarSessionTooltipActiveTarget = {
  key: string;
  anchor: HTMLElement;
};

export type SidebarSessionTooltipController = {
  activeTarget: SidebarSessionTooltipActiveTarget | null;
  onBlurCapture: (event: ReactFocusEvent<HTMLDivElement>) => void;
  onFocusCapture: (event: ReactFocusEvent<HTMLDivElement>) => void;
  onPointerOut: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerOver: (event: ReactPointerEvent<HTMLDivElement>) => void;
  reset: () => void;
};

function supportsDesktopHover(): boolean {
  return typeof window !== "undefined" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

function closestSessionRow(
  target: EventTarget | null,
  boundary?: HTMLElement,
): HTMLElement | null {
  const row = target instanceof Element
    ? target.closest<HTMLElement>(`[${SIDEBAR_SESSION_TOOLTIP_KEY_ATTRIBUTE}]`)
    : null;
  if (!row || (boundary && !boundary.contains(row))) {
    return null;
  }
  return row;
}

function sessionRowKey(row: HTMLElement): string | null {
  return row.getAttribute(SIDEBAR_SESSION_TOOLTIP_KEY_ATTRIBUTE);
}

export function useSidebarSessionTooltipController(): SidebarSessionTooltipController {
  const [state, dispatch] = useReducer(
    reduceSidebarSessionTooltipState,
    INITIAL_SIDEBAR_SESSION_TOOLTIP_STATE,
  );

  const reset = useCallback(() => {
    dispatch({ type: "cancel" });
  }, []);

  useEffect(() => {
    if (state.phase !== "pending") {
      return;
    }
    const anchor = state.anchor as HTMLElement;
    const epoch = state.epoch;
    const timeoutId = window.setTimeout(() => {
      dispatch({
        type: "delay-elapsed",
        epoch,
        eligible: anchor.isConnected && anchor.matches(":hover"),
      });
    }, SIDEBAR_SESSION_TOOLTIP_HOVER_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [state]);

  useLayoutEffect(() => {
    if (
      state.phase !== "idle" &&
      !(state.anchor as HTMLElement).isConnected
    ) {
      dispatch({ type: "cancel" });
    }
  });

  useEffect(() => {
    if (state.phase === "idle" || typeof MutationObserver === "undefined") {
      return;
    }
    const anchor = state.anchor as HTMLElement;
    const closeIfAnchorWasRemoved = () => {
      if (!anchor.isConnected) {
        reset();
      }
    };
    const observer = new MutationObserver(closeIfAnchorWasRemoved);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [reset, state]);

  useEffect(() => {
    const close = () => reset();
    const closeOnKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    const closeOnFocusOutsideSession = (event: FocusEvent) => {
      if (!closestSessionRow(event.target)) {
        close();
      }
    };
    const closeOnPointerLeavingWindow = (event: PointerEvent) => {
      if (event.relatedTarget === null) {
        close();
      }
    };
    const closeWhenHidden = () => {
      if (document.hidden) {
        close();
      }
    };

    document.addEventListener("pointerdown", close, true);
    document.addEventListener("focusin", closeOnFocusOutsideSession, true);
    document.addEventListener("keydown", closeOnKeyDown);
    document.addEventListener("visibilitychange", closeWhenHidden);
    window.addEventListener("pointerout", closeOnPointerLeavingWindow);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("focusin", closeOnFocusOutsideSession, true);
      document.removeEventListener("keydown", closeOnKeyDown);
      document.removeEventListener("visibilitychange", closeWhenHidden);
      window.removeEventListener("pointerout", closeOnPointerLeavingWindow);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
    };
  }, [reset]);

  const onPointerOver = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" || !supportsDesktopHover()) {
      return;
    }
    const row = closestSessionRow(event.target, event.currentTarget);
    const key = row ? sessionRowKey(row) : null;
    if (row && key) {
      dispatch({ type: "pointer-enter", key, anchor: row });
    }
  }, []);

  const onPointerOut = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const row = closestSessionRow(event.target, event.currentTarget);
    const key = row ? sessionRowKey(row) : null;
    if (!row || !key) {
      return;
    }
    const relatedRow = closestSessionRow(event.relatedTarget, event.currentTarget);
    if (relatedRow === row) {
      return;
    }
    dispatch({ type: "pointer-leave", key, anchor: row });
  }, []);

  const onFocusCapture = useCallback((event: ReactFocusEvent<HTMLDivElement>) => {
    if (
      !supportsDesktopHover() ||
      !(event.target instanceof HTMLElement) ||
      !event.target.matches(":focus-visible")
    ) {
      return;
    }
    const row = closestSessionRow(event.target, event.currentTarget);
    const key = row ? sessionRowKey(row) : null;
    if (row && key) {
      dispatch({ type: "keyboard-focus", key, anchor: row });
    }
  }, []);

  const onBlurCapture = useCallback((event: ReactFocusEvent<HTMLDivElement>) => {
    const row = closestSessionRow(event.target, event.currentTarget);
    const key = row ? sessionRowKey(row) : null;
    if (!row || !key) {
      return;
    }
    const relatedRow = closestSessionRow(event.relatedTarget, event.currentTarget);
    if (relatedRow === row) {
      return;
    }
    dispatch({ type: "pointer-leave", key, anchor: row });
  }, []);

  const activeTarget = useMemo<SidebarSessionTooltipActiveTarget | null>(
    () => state.phase === "open"
      ? { key: state.key, anchor: state.anchor as HTMLElement }
      : null,
    [state],
  );

  return useMemo(
    () => ({
      activeTarget,
      onBlurCapture,
      onFocusCapture,
      onPointerOut,
      onPointerOver,
      reset,
    }),
    [
      activeTarget,
      onBlurCapture,
      onFocusCapture,
      onPointerOut,
      onPointerOver,
      reset,
    ],
  );
}
