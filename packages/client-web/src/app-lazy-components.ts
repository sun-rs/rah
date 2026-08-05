import { lazy } from "react";
import { importWithStaleReload } from "./lazy-module-reload";

const loadSettingsDialog = () =>
  importWithStaleReload(() => import("./components/workbench/dialogs/SettingsDialog"));
export const SettingsDialog = lazy(async () => ({
  default: (await loadSettingsDialog()).SettingsDialog,
}));

const loadWorkbenchTerminalDialog = () =>
  importWithStaleReload(() => import("./components/workbench/dialogs/WorkbenchTerminalDialog"));
export const WorkbenchTerminalDialog = lazy(async () => ({
  default: (await loadWorkbenchTerminalDialog()).WorkbenchTerminalDialog,
}));

const loadInspectorPane = () => importWithStaleReload(() => import("./InspectorPane"));
export const InspectorPane = lazy(async () => ({
  default: (await loadInspectorPane()).InspectorPane,
}));

const loadCouncilPage = () => importWithStaleReload(() => import("./council/CouncilPage"));
export const CouncilPage = lazy(async () => ({
  default: (await loadCouncilPage()).CouncilPage,
}));

const loadFileReferencePicker = () =>
  importWithStaleReload(() => import("./components/FileReferencePicker"));
export const FileReferencePicker = lazy(async () => ({
  default: (await loadFileReferencePicker()).FileReferencePicker,
}));

const loadSessionHistoryDialog = () =>
  importWithStaleReload(() => import("./components/SessionHistoryDialog"));
export const SessionHistoryDialog = lazy(async () => ({
  default: (await loadSessionHistoryDialog()).SessionHistoryDialog,
}));

const loadWorkbenchSelectedPane = () =>
  importWithStaleReload(() => import("./components/workbench/panes/WorkbenchSelectedPane"));
export const WorkbenchSelectedPane = lazy(async () => ({
  default: (await loadWorkbenchSelectedPane()).WorkbenchSelectedPane,
}));

const loadCanvasSessionPane = () =>
  importWithStaleReload(() => import("./components/workbench/canvas/CanvasSessionPane"));
export const CanvasSessionPane = lazy(async () => ({
  default: (await loadCanvasSessionPane()).CanvasSessionPane,
}));

const loadCanvasNewSessionPane = () =>
  importWithStaleReload(() => import("./components/workbench/canvas/CanvasNewSessionPane"));
export const CanvasNewSessionPane = lazy(async () => ({
  default: (await loadCanvasNewSessionPane()).CanvasNewSessionPane,
}));

const loadCanvasWorkbench = () =>
  importWithStaleReload(() => import("./components/workbench/canvas/CanvasWorkbench"));
export const CanvasWorkbench = lazy(async () => ({
  default: (await loadCanvasWorkbench()).CanvasWorkbench,
}));

const loadNewCouncilDialog = () =>
  importWithStaleReload(() => import("./council/NewCouncilDialog"));
export const NewCouncilDialog = lazy(async () => ({
  default: (await loadNewCouncilDialog()).NewCouncilDialog,
}));
