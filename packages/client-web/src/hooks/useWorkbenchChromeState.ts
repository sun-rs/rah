import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

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

  sidebarWidthRef.current = sidebarWidth;

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!isResizing) {
        return;
      }
      setSidebarWidth(Math.max(200, Math.min(480, event.clientX)));
    };

    const onUp = () => {
      if (!isResizing) {
        return;
      }
      setIsResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        window.localStorage.setItem("rah-sidebar-width", String(sidebarWidthRef.current));
      } catch {
        // ignore
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
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

  const startSidebarResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
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
