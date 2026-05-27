import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

function readBooleanPreference(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value !== "false";
  } catch {
    return fallback;
  }
}

function readNumberPreference(key: string, fallback: number): number {
  try {
    const value = Number(window.localStorage.getItem(key));
    if (!Number.isFinite(value)) {
      return fallback;
    }
    return value;
  } catch {
    return fallback;
  }
}

function readVisualViewportBottomInset(): number {
  if (typeof window === "undefined" || !window.visualViewport) {
    return 0;
  }
  return Math.max(
    0,
    window.innerHeight - (window.visualViewport.height + window.visualViewport.offsetTop),
  );
}

function readViewportWidth(): number {
  return typeof window === "undefined" ? 1024 : window.innerWidth;
}

const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 288;
const SIDEBAR_WIDTH_CSS_VAR = "--rah-sidebar-width";

function clampSidebarWidth(value: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, value));
}

function applySidebarWidthCss(width: number): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.style.setProperty(SIDEBAR_WIDTH_CSS_VAR, `${width}px`);
}

export function useWorkbenchChromeState() {
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [fileReferenceOpen, setFileReferenceOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window === "undefined" ? true : readBooleanPreference("rah-sidebar-open", true),
  );
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    typeof window === "undefined"
      ? SIDEBAR_DEFAULT_WIDTH
      : clampSidebarWidth(readNumberPreference("rah-sidebar-width", SIDEBAR_DEFAULT_WIDTH)),
  );
  const [visualViewportBottomInsetPx, setVisualViewportBottomInsetPx] = useState(() =>
    typeof window === "undefined" ? 0 : readVisualViewportBottomInset(),
  );
  const [viewportWidthPx, setViewportWidthPx] = useState(() => readViewportWidth());
  const [isResizing, setIsResizing] = useState(false);
  const sidebarWidthRef = useRef(sidebarWidth);
  const pendingSidebarWidthRef = useRef(sidebarWidth);
  const sidebarResizeFrameRef = useRef<number | null>(null);
  const activePointerIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (isResizing) {
      return;
    }
    sidebarWidthRef.current = sidebarWidth;
    pendingSidebarWidthRef.current = sidebarWidth;
    applySidebarWidthCss(sidebarWidth);
  }, [isResizing, sidebarWidth]);

  useEffect(() => {
    const flushPendingSidebarWidth = () => {
      sidebarResizeFrameRef.current = null;
      applySidebarWidthCss(pendingSidebarWidthRef.current);
    };
    const scheduleSidebarWidthFlush = () => {
      if (sidebarResizeFrameRef.current !== null) {
        return;
      }
      sidebarResizeFrameRef.current = window.requestAnimationFrame(flushPendingSidebarWidth);
    };

    const onMove = (event: PointerEvent) => {
      if (!isResizing) {
        return;
      }
      if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) {
        return;
      }
      const nextWidth = clampSidebarWidth(event.clientX);
      sidebarWidthRef.current = nextWidth;
      pendingSidebarWidthRef.current = nextWidth;
      scheduleSidebarWidthFlush();
    };

    const onUp = (event: PointerEvent) => {
      if (!isResizing) {
        return;
      }
      if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) {
        return;
      }
      const finalWidth =
        event.type === "pointerup" ? clampSidebarWidth(event.clientX) : sidebarWidthRef.current;
      activePointerIdRef.current = null;
      sidebarWidthRef.current = finalWidth;
      pendingSidebarWidthRef.current = finalWidth;
      if (sidebarResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(sidebarResizeFrameRef.current);
        sidebarResizeFrameRef.current = null;
      }
      applySidebarWidthCss(finalWidth);
      setSidebarWidth(finalWidth);
      setIsResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        window.localStorage.setItem("rah-sidebar-width", String(finalWidth));
      } catch {
        // ignore
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (sidebarResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(sidebarResizeFrameRef.current);
        sidebarResizeFrameRef.current = null;
      }
    };
  }, [isResizing]);

  useEffect(() => {
    try {
      window.localStorage.setItem("rah-sidebar-open", String(sidebarOpen));
    } catch {
      // ignore
    }
  }, [sidebarOpen]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let viewportFrame: number | null = null;
    const updateVisualViewportInset = () => {
      viewportFrame = null;
      const nextInset = readVisualViewportBottomInset();
      setVisualViewportBottomInsetPx((currentInset) =>
        currentInset === nextInset ? currentInset : nextInset,
      );
      const nextWidth = readViewportWidth();
      setViewportWidthPx((currentWidth) => (currentWidth === nextWidth ? currentWidth : nextWidth));
    };
    const scheduleVisualViewportInsetUpdate = () => {
      if (viewportFrame !== null) {
        return;
      }
      viewportFrame = window.requestAnimationFrame(updateVisualViewportInset);
    };

    scheduleVisualViewportInsetUpdate();
    window.addEventListener("resize", scheduleVisualViewportInsetUpdate);
    window.visualViewport?.addEventListener("resize", scheduleVisualViewportInsetUpdate);
    window.visualViewport?.addEventListener("scroll", scheduleVisualViewportInsetUpdate);

    return () => {
      window.removeEventListener("resize", scheduleVisualViewportInsetUpdate);
      window.visualViewport?.removeEventListener("resize", scheduleVisualViewportInsetUpdate);
      window.visualViewport?.removeEventListener("scroll", scheduleVisualViewportInsetUpdate);
      if (viewportFrame !== null) {
        window.cancelAnimationFrame(viewportFrame);
      }
    };
  }, []);

  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    activePointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setIsResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return {
    fileReferenceOpen,
    isResizing,
    leftOpen,
    rightOpen,
    rightSidebarOpen,
    settingsOpen,
    sidebarOpen,
    sidebarWidth,
    terminalOpen,
    visualViewportBottomInsetPx,
    viewportWidthPx,
    setFileReferenceOpen,
    setLeftOpen,
    setRightOpen,
    setRightSidebarOpen,
    setSettingsOpen,
    setSidebarOpen,
    setTerminalOpen,
    startSidebarResize,
  };
}
