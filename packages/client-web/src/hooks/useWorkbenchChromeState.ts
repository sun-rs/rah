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
      ? 288
      : Math.max(200, Math.min(480, readNumberPreference("rah-sidebar-width", 288))),
  );
  const [visualViewportBottomInsetPx, setVisualViewportBottomInsetPx] = useState(() =>
    typeof window === "undefined" ? 0 : readVisualViewportBottomInset(),
  );
  const [isResizing, setIsResizing] = useState(false);
  const sidebarWidthRef = useRef(sidebarWidth);
  const activePointerIdRef = useRef<number | null>(null);

  sidebarWidthRef.current = sidebarWidth;

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!isResizing) {
        return;
      }
      if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) {
        return;
      }
      setSidebarWidth(Math.max(200, Math.min(480, event.clientX)));
    };

    const onUp = (event: PointerEvent) => {
      if (!isResizing) {
        return;
      }
      if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) {
        return;
      }
      activePointerIdRef.current = null;
      setIsResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        window.localStorage.setItem("rah-sidebar-width", String(sidebarWidthRef.current));
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
