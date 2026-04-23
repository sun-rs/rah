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

export function useWorkbenchChromeState() {
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [fileReferenceOpen, setFileReferenceOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window === "undefined" ? true : readBooleanPreference("rah-sidebar-open", true),
  );
  const [rightSidebarOpen, setRightSidebarOpen] = useState(() =>
    typeof window === "undefined"
      ? true
      : readBooleanPreference("rah-right-sidebar-open", true),
  );
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    typeof window === "undefined"
      ? 288
      : Math.max(200, Math.min(480, readNumberPreference("rah-sidebar-width", 288))),
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
    try {
      window.localStorage.setItem("rah-right-sidebar-open", String(rightSidebarOpen));
    } catch {
      // ignore
    }
  }, [rightSidebarOpen]);

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
