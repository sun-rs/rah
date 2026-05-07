import type {
  ProviderActionCapabilityAdapter,
  ProviderAdapter,
  ProviderCapabilityView,
  ProviderDebugAdapter,
  ProviderDiagnosticAdapter,
  ProviderEnhancedModeAdapter,
  ProviderEnhancedModelAdapter,
  ProviderShutdownAdapter,
  ProviderStoredHistoryAdapter,
  ProviderStructuredInputControlAdapter,
  ProviderStructuredLifecycleAdapter,
  ProviderStructuredPermissionAdapter,
  ProviderWorkspaceInspectionAdapter,
} from "./provider-adapter";

export function hasStoredHistoryCapability(
  adapter: ProviderAdapter,
): adapter is ProviderAdapter & ProviderStoredHistoryAdapter {
  return (
    typeof (adapter as Partial<ProviderStoredHistoryAdapter>).getSessionHistoryPage ===
      "function" ||
    typeof (adapter as Partial<ProviderStoredHistoryAdapter>).createFrozenHistoryPageLoader ===
      "function" ||
    typeof (adapter as Partial<ProviderStoredHistoryAdapter>).listStoredSessions === "function" ||
    typeof (adapter as Partial<ProviderStoredHistoryAdapter>).refreshStoredSessionsCatalog ===
      "function" ||
    typeof (adapter as Partial<ProviderStoredHistoryAdapter>).listStoredSessionWatchRoots ===
      "function" ||
    typeof (adapter as Partial<ProviderStoredHistoryAdapter>).removeStoredSession === "function"
  );
}

export function bindStoredHistoryCapability(
  adapter: ProviderAdapter & ProviderStoredHistoryAdapter,
): ProviderStoredHistoryAdapter {
  return {
    ...(adapter.getSessionHistoryPage
      ? { getSessionHistoryPage: adapter.getSessionHistoryPage.bind(adapter) }
      : {}),
    ...(adapter.createFrozenHistoryPageLoader
      ? { createFrozenHistoryPageLoader: adapter.createFrozenHistoryPageLoader.bind(adapter) }
      : {}),
    ...(adapter.listStoredSessions
      ? { listStoredSessions: adapter.listStoredSessions.bind(adapter) }
      : {}),
    ...(adapter.refreshStoredSessionsCatalog
      ? { refreshStoredSessionsCatalog: adapter.refreshStoredSessionsCatalog.bind(adapter) }
      : {}),
    ...(adapter.listStoredSessionWatchRoots
      ? { listStoredSessionWatchRoots: adapter.listStoredSessionWatchRoots.bind(adapter) }
      : {}),
    ...(adapter.removeStoredSession
      ? { removeStoredSession: adapter.removeStoredSession.bind(adapter) }
      : {}),
  };
}

export function hasStructuredLifecycleCapability(
  adapter: ProviderAdapter,
): adapter is ProviderAdapter & ProviderStructuredLifecycleAdapter {
  return (
    typeof (adapter as Partial<ProviderStructuredLifecycleAdapter>).startSession === "function" ||
    typeof (adapter as Partial<ProviderStructuredLifecycleAdapter>).resumeSession === "function" ||
    typeof (adapter as Partial<ProviderStructuredLifecycleAdapter>).closeSession === "function" ||
    typeof (adapter as Partial<ProviderStructuredLifecycleAdapter>).destroySession === "function"
  );
}

export function bindStructuredLifecycleCapability(
  adapter: ProviderAdapter & ProviderStructuredLifecycleAdapter,
): ProviderCapabilityView<ProviderStructuredLifecycleAdapter> {
  return {
    id: adapter.id,
    ...(adapter.startSession ? { startSession: adapter.startSession.bind(adapter) } : {}),
    ...(adapter.resumeSession ? { resumeSession: adapter.resumeSession.bind(adapter) } : {}),
    ...(adapter.closeSession ? { closeSession: adapter.closeSession.bind(adapter) } : {}),
    ...(adapter.destroySession ? { destroySession: adapter.destroySession.bind(adapter) } : {}),
  };
}

export function hasStructuredInputControlCapability(
  adapter: ProviderAdapter,
): adapter is ProviderAdapter & ProviderStructuredInputControlAdapter {
  return (
    typeof (adapter as Partial<ProviderStructuredInputControlAdapter>).sendInput === "function" &&
    typeof (adapter as Partial<ProviderStructuredInputControlAdapter>).interruptSession ===
      "function" &&
    typeof (adapter as Partial<ProviderStructuredInputControlAdapter>).onPtyInput === "function" &&
    typeof (adapter as Partial<ProviderStructuredInputControlAdapter>).onPtyResize === "function"
  );
}

export function bindStructuredInputControlCapability(
  adapter: ProviderAdapter & ProviderStructuredInputControlAdapter,
): ProviderCapabilityView<ProviderStructuredInputControlAdapter> {
  return {
    id: adapter.id,
    sendInput: adapter.sendInput.bind(adapter),
    interruptSession: adapter.interruptSession.bind(adapter),
    onPtyInput: adapter.onPtyInput.bind(adapter),
    onPtyResize: adapter.onPtyResize.bind(adapter),
  };
}

export function hasStructuredPermissionCapability(
  adapter: ProviderAdapter,
): adapter is ProviderAdapter & Required<ProviderStructuredPermissionAdapter> {
  return typeof (adapter as Partial<ProviderStructuredPermissionAdapter>).respondToPermission ===
    "function";
}

export function bindStructuredPermissionCapability(
  adapter: ProviderAdapter & Required<ProviderStructuredPermissionAdapter>,
): ProviderCapabilityView<Required<ProviderStructuredPermissionAdapter>> {
  return {
    id: adapter.id,
    respondToPermission: adapter.respondToPermission.bind(adapter),
  };
}

export function hasWorkspaceInspectionCapability(
  adapter: ProviderAdapter,
): adapter is ProviderAdapter & ProviderWorkspaceInspectionAdapter {
  return (
    typeof (adapter as Partial<ProviderWorkspaceInspectionAdapter>).getWorkspaceSnapshot ===
      "function" &&
    typeof (adapter as Partial<ProviderWorkspaceInspectionAdapter>).getGitStatus === "function" &&
    typeof (adapter as Partial<ProviderWorkspaceInspectionAdapter>).getGitDiff === "function" &&
    typeof (adapter as Partial<ProviderWorkspaceInspectionAdapter>).readSessionFile === "function"
  );
}

export function bindWorkspaceInspectionCapability(
  adapter: ProviderAdapter & ProviderWorkspaceInspectionAdapter,
): ProviderCapabilityView<ProviderWorkspaceInspectionAdapter> {
  return {
    id: adapter.id,
    getWorkspaceSnapshot: adapter.getWorkspaceSnapshot.bind(adapter),
    getGitStatus: adapter.getGitStatus.bind(adapter),
    getGitDiff: adapter.getGitDiff.bind(adapter),
    ...(adapter.applyGitFileAction
      ? { applyGitFileAction: adapter.applyGitFileAction.bind(adapter) }
      : {}),
    ...(adapter.applyGitHunkAction
      ? { applyGitHunkAction: adapter.applyGitHunkAction.bind(adapter) }
      : {}),
    readSessionFile: adapter.readSessionFile.bind(adapter),
  };
}

export function hasEnhancedModeCapability(
  adapter: ProviderAdapter,
): adapter is ProviderAdapter & ProviderEnhancedModeAdapter {
  return typeof (adapter as Partial<ProviderEnhancedModeAdapter>).setSessionMode === "function";
}

export function bindEnhancedModeCapability(
  adapter: ProviderAdapter & ProviderEnhancedModeAdapter,
): ProviderCapabilityView<ProviderEnhancedModeAdapter> {
  return {
    id: adapter.id,
    ...(adapter.setSessionMode ? { setSessionMode: adapter.setSessionMode.bind(adapter) } : {}),
  };
}

export function hasEnhancedModelCapability(
  adapter: ProviderAdapter,
): adapter is ProviderAdapter & ProviderEnhancedModelAdapter {
  return (
    typeof (adapter as Partial<ProviderEnhancedModelAdapter>).listModels === "function" ||
    typeof (adapter as Partial<ProviderEnhancedModelAdapter>).setSessionModel === "function"
  );
}

export function bindEnhancedModelCapability(
  adapter: ProviderAdapter & ProviderEnhancedModelAdapter,
): ProviderCapabilityView<ProviderEnhancedModelAdapter> {
  return {
    id: adapter.id,
    ...(adapter.listModels ? { listModels: adapter.listModels.bind(adapter) } : {}),
    ...(adapter.setSessionModel ? { setSessionModel: adapter.setSessionModel.bind(adapter) } : {}),
  };
}

export function hasActionCapability(
  adapter: ProviderAdapter,
): adapter is ProviderAdapter & ProviderActionCapabilityAdapter {
  return typeof (adapter as Partial<ProviderActionCapabilityAdapter>).renameSession === "function";
}

export function bindActionCapability(
  adapter: ProviderAdapter & ProviderActionCapabilityAdapter,
): ProviderCapabilityView<ProviderActionCapabilityAdapter> {
  return {
    id: adapter.id,
    ...(adapter.renameSession ? { renameSession: adapter.renameSession.bind(adapter) } : {}),
  };
}

export function hasDiagnosticCapability(
  adapter: ProviderAdapter,
): adapter is ProviderAdapter & ProviderDiagnosticAdapter {
  return typeof (adapter as Partial<ProviderDiagnosticAdapter>).getProviderDiagnostic === "function";
}

export function bindDiagnosticCapability(
  adapter: ProviderAdapter & ProviderDiagnosticAdapter,
): ProviderCapabilityView<ProviderDiagnosticAdapter> {
  return {
    id: adapter.id,
    ...(adapter.getProviderDiagnostic
      ? { getProviderDiagnostic: adapter.getProviderDiagnostic.bind(adapter) }
      : {}),
  };
}

export function hasDebugCapability(
  adapter: ProviderAdapter,
): adapter is ProviderAdapter & ProviderDebugAdapter {
  return (
    typeof (adapter as Partial<ProviderDebugAdapter>).listDebugScenarios === "function" ||
    typeof (adapter as Partial<ProviderDebugAdapter>).startDebugScenario === "function" ||
    typeof (adapter as Partial<ProviderDebugAdapter>).buildDebugScenarioReplayScript === "function"
  );
}

export function bindDebugCapability(
  adapter: ProviderAdapter & ProviderDebugAdapter,
): ProviderCapabilityView<ProviderDebugAdapter> {
  return {
    id: adapter.id,
    ...(adapter.listDebugScenarios
      ? { listDebugScenarios: adapter.listDebugScenarios.bind(adapter) }
      : {}),
    ...(adapter.startDebugScenario
      ? { startDebugScenario: adapter.startDebugScenario.bind(adapter) }
      : {}),
    ...(adapter.buildDebugScenarioReplayScript
      ? { buildDebugScenarioReplayScript: adapter.buildDebugScenarioReplayScript.bind(adapter) }
      : {}),
  };
}

export function hasShutdownCapability(
  adapter: ProviderAdapter,
): adapter is ProviderAdapter & ProviderShutdownAdapter {
  return typeof (adapter as Partial<ProviderShutdownAdapter>).shutdown === "function";
}

export function bindShutdownCapability(
  adapter: ProviderAdapter & ProviderShutdownAdapter,
): ProviderCapabilityView<ProviderShutdownAdapter> {
  return {
    id: adapter.id,
    ...(adapter.shutdown ? { shutdown: adapter.shutdown.bind(adapter) } : {}),
  };
}
