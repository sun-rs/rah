import { useCallback, useState } from "react";

export type WorkbenchMode = "single" | "canvas" | "council";

type WorkbenchPageControllerOptions = {
  setSelectedSessionId: (sessionId: string | null) => void;
  setSelectedCouncilId: (councilId: string | null) => void;
  setSelectedWorkspaceOnlyDir: (workspaceDir: string | null) => void;
  setLeftOpen: (open: boolean) => void;
  setRightOpen: (open: boolean) => void;
  setRightSidebarOpen: (open: boolean) => void;
};

export function resolveModeAfterCanvasExit(target: {
  sessionId?: string | null;
  councilId?: string | null;
}): WorkbenchMode {
  return target.councilId ? "council" : "single";
}

export function useWorkbenchPageController(options: WorkbenchPageControllerOptions) {
  const [mode, setMode] = useState<WorkbenchMode>("single");
  const [sessionNavigationRevision, setSessionNavigationRevision] = useState(0);

  const markSessionNavigation = useCallback(() => {
    setSessionNavigationRevision((revision) => revision + 1);
  }, []);

  const closeRightPanels = useCallback(() => {
    options.setRightSidebarOpen(false);
    options.setRightOpen(false);
  }, [options.setRightOpen, options.setRightSidebarOpen]);

  const openSession = useCallback((_workspaceDir: string, sessionId: string) => {
    markSessionNavigation();
    setMode("single");
    options.setSelectedWorkspaceOnlyDir(null);
    options.setSelectedCouncilId(null);
    options.setSelectedSessionId(sessionId);
    options.setLeftOpen(false);
  }, [
    markSessionNavigation,
    options.setLeftOpen,
    options.setSelectedCouncilId,
    options.setSelectedSessionId,
    options.setSelectedWorkspaceOnlyDir,
  ]);

  const openWorkspace = useCallback((workspaceDir: string) => {
    setMode("single");
    options.setSelectedWorkspaceOnlyDir(workspaceDir);
    options.setSelectedSessionId(null);
    options.setSelectedCouncilId(null);
    closeRightPanels();
    options.setLeftOpen(false);
  }, [
    closeRightPanels,
    options.setLeftOpen,
    options.setSelectedCouncilId,
    options.setSelectedSessionId,
    options.setSelectedWorkspaceOnlyDir,
  ]);

  const openCouncil = useCallback((_workspaceDir: string, councilId: string) => {
    options.setSelectedWorkspaceOnlyDir(null);
    options.setSelectedSessionId(null);
    options.setSelectedCouncilId(councilId);
    setMode("council");
    closeRightPanels();
    options.setLeftOpen(false);
  }, [
    closeRightPanels,
    options.setLeftOpen,
    options.setSelectedCouncilId,
    options.setSelectedSessionId,
    options.setSelectedWorkspaceOnlyDir,
  ]);

  const openCouncilLanding = useCallback((councilId: string | null) => {
    options.setSelectedCouncilId(councilId);
    setMode("council");
    closeRightPanels();
    options.setLeftOpen(false);
  }, [closeRightPanels, options.setLeftOpen, options.setSelectedCouncilId]);

  const prepareHistorySession = useCallback(() => {
    markSessionNavigation();
    setMode("single");
    options.setLeftOpen(false);
  }, [markSessionNavigation, options.setLeftOpen]);

  const enterCanvas = useCallback(() => {
    setMode("canvas");
    closeRightPanels();
  }, [closeRightPanels]);

  const exitCanvas = useCallback((target: {
    sessionId?: string | null;
    councilId?: string | null;
  }) => {
    if (target.sessionId) {
      options.setSelectedSessionId(target.sessionId);
    }
    if (target.councilId) {
      options.setSelectedCouncilId(target.councilId);
    }
    setMode(resolveModeAfterCanvasExit(target));
  }, [options.setSelectedCouncilId, options.setSelectedSessionId]);

  const hideCouncil = useCallback(() => {
    options.setSelectedCouncilId(null);
    setMode("single");
    closeRightPanels();
    options.setLeftOpen(false);
  }, [closeRightPanels, options.setLeftOpen, options.setSelectedCouncilId]);

  const goHome = useCallback(() => {
    setMode("single");
    options.setSelectedWorkspaceOnlyDir(null);
    options.setSelectedSessionId(null);
    options.setSelectedCouncilId(null);
    closeRightPanels();
    options.setLeftOpen(false);
  }, [
    closeRightPanels,
    options.setLeftOpen,
    options.setSelectedCouncilId,
    options.setSelectedSessionId,
    options.setSelectedWorkspaceOnlyDir,
  ]);

  return {
    mode,
    sessionNavigationRevision,
    openSession,
    openWorkspace,
    openCouncil,
    openCouncilLanding,
    prepareHistorySession,
    enterCanvas,
    exitCanvas,
    hideCouncil,
    goHome,
  };
}
