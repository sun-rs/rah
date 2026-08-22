import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { LoaderCircle, Maximize2, Minimize2, Minus, X } from "lucide-react";
import type { NotebookPreviewData } from "@rah/runtime-protocol";
import {
  applyGitFileAction,
  readGitDiff,
  readHostFile,
  readSessionFile,
  readTurnFileDiff,
  readWorkspaceFile,
  readWorkspaceGitDiff,
} from "../api";
import { SegmentedButton, SegmentedButtonLabel, SegmentedControl } from "../components/SegmentedControl";
import { SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS } from "../components/segmented-control-styles";
import type { DiffLayout, FileDetailSelection } from "./shared";
import {
  DelimitedTablePreview,
  FileContentDisplay,
  ImageFilePreview,
  MarkdownFilePreview,
  NotebookPreview,
} from "./InspectorPreviewDisplays";
import { resolveFilePreviewKind } from "./file-preview-utils";
import { HtmlFilePreview } from "./HtmlFilePreview";
import { FileInspectionDiffSurface } from "./FileInspectionDiffSurface";
import {
  buildDiffRows,
  getChangeScopeLabel,
  getChangedFileStatusLabel,
  getChangedFileStatusTone,
  getDisplayPath,
  getTurnArtifactErrorMessage,
  readDiffPreferences,
  summarizeDiffRows,
  writeDiffPreferences,
} from "./shared";

type ViewerGeometry = { x: number; y: number; width: number; height: number };
type ResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
type ViewerInteraction = {
  mode: "move" | "resize";
  direction?: ResizeDirection;
  startX: number;
  startY: number;
  geometry: ViewerGeometry;
};
export type PaneWindowVerticalGeometry = { top: number; height: number };
type PaneWindowResizeDirection = "n" | "s";
type PaneWindowResizeInteraction = {
  direction: PaneWindowResizeDirection;
  startY: number;
  geometry: PaneWindowVerticalGeometry;
  boundsHeight: number;
};

const VIEWER_MIN_WIDTH = 480;
const VIEWER_MIN_HEIGHT = 320;
export const PANE_WINDOW_MIN_HEIGHT = 280;
export const PANE_WINDOW_DEFAULT_HEIGHT =
  "min(68rem, max(42rem, 82%), calc(100% - 4rem))";
export const PANE_WINDOW_DEFAULT_WIDTH =
  "min(52rem, max(22rem, calc(60% - 1rem)), calc(100% - 2rem))";
const PANE_WINDOW_TOP_BOUNDARY = 40;
const PANE_WINDOW_BOTTOM_MARGIN = 16;

const RESIZE_HANDLES: ReadonlyArray<{ direction: ResizeDirection; className: string }> = [
  { direction: "n", className: "left-3 right-3 top-0 h-2 cursor-ns-resize" },
  { direction: "ne", className: "right-0 top-0 h-3 w-3 cursor-nesw-resize" },
  { direction: "e", className: "bottom-3 right-0 top-3 w-2 cursor-ew-resize" },
  { direction: "se", className: "bottom-0 right-0 h-3 w-3 cursor-nwse-resize" },
  { direction: "s", className: "bottom-0 left-3 right-3 h-2 cursor-ns-resize" },
  { direction: "sw", className: "bottom-0 left-0 h-3 w-3 cursor-nesw-resize" },
  { direction: "w", className: "bottom-3 left-0 top-3 w-2 cursor-ew-resize" },
  { direction: "nw", className: "left-0 top-0 h-3 w-3 cursor-nwse-resize" },
];

function DiffLayoutControl(props: {
  value: DiffLayout;
  onChange: (layout: DiffLayout) => void;
}) {
  return (
    <SegmentedControl
      size="compact"
      className="flex w-[9.5rem] shrink-0 gap-1"
      role="group"
      ariaLabel="Diff layout"
    >
      <SegmentedButton
        size="compact"
        selected={props.value === "unified"}
        selectedClassName={SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS}
        onClick={() => props.onChange("unified")}
        className="flex-1"
        aria-pressed={props.value === "unified"}
      >
        <SegmentedButtonLabel size="compact">Unified</SegmentedButtonLabel>
      </SegmentedButton>
      <SegmentedButton
        size="compact"
        selected={props.value === "split"}
        selectedClassName={SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS}
        onClick={() => props.onChange("split")}
        className="flex-1"
        aria-pressed={props.value === "split"}
      >
        <SegmentedButtonLabel size="compact">Split</SegmentedButtonLabel>
      </SegmentedButton>
    </SegmentedControl>
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function fitPaneWindowVerticalGeometry(
  geometry: PaneWindowVerticalGeometry,
  boundsHeight: number,
): PaneWindowVerticalGeometry {
  const bottomLimit = Math.max(PANE_WINDOW_TOP_BOUNDARY + 1, boundsHeight - PANE_WINDOW_BOTTOM_MARGIN);
  const availableHeight = Math.max(1, bottomLimit - PANE_WINDOW_TOP_BOUNDARY);
  const minimumHeight = Math.min(PANE_WINDOW_MIN_HEIGHT, availableHeight);
  const height = clamp(geometry.height, minimumHeight, availableHeight);
  return {
    top: clamp(
      geometry.top,
      PANE_WINDOW_TOP_BOUNDARY,
      bottomLimit - height,
    ),
    height,
  };
}

export function resizePaneWindowVertically(
  geometry: PaneWindowVerticalGeometry,
  direction: PaneWindowResizeDirection,
  deltaY: number,
  boundsHeight: number,
): PaneWindowVerticalGeometry {
  const fitted = fitPaneWindowVerticalGeometry(geometry, boundsHeight);
  const bottomLimit = Math.max(PANE_WINDOW_TOP_BOUNDARY + 1, boundsHeight - PANE_WINDOW_BOTTOM_MARGIN);
  const availableHeight = Math.max(1, bottomLimit - PANE_WINDOW_TOP_BOUNDARY);
  const minimumHeight = Math.min(PANE_WINDOW_MIN_HEIGHT, availableHeight);
  if (direction === "n") {
    const bottom = fitted.top + fitted.height;
    const top = clamp(
      fitted.top + deltaY,
      PANE_WINDOW_TOP_BOUNDARY,
      bottom - minimumHeight,
    );
    return { top, height: bottom - top };
  }
  const bottom = clamp(
    fitted.top + fitted.height + deltaY,
    fitted.top + minimumHeight,
    bottomLimit,
  );
  return { top: fitted.top, height: bottom - fitted.top };
}

type ViewerBounds = { left: number; top: number; width: number; height: number };

function findViewerAnchor(sessionId: string | null): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const anchors = Array.from(
    document.querySelectorAll<HTMLElement>("[data-inspector-file-viewer-anchor]"),
  ).filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  const matching = sessionId
    ? anchors.filter((element) => element.dataset.inspectorFileViewerAnchor === sessionId)
    : anchors;
  return [...(matching.length > 0 ? matching : anchors)].sort((left, right) => {
    const leftRect = left.getBoundingClientRect();
    const rightRect = right.getBoundingClientRect();
    return rightRect.width * rightRect.height - leftRect.width * leftRect.height;
  })[0] ?? null;
}

export function calculateInitialViewerGeometry(
  anchor: ViewerBounds,
  viewport: { width: number; height: number },
): ViewerGeometry {
  const viewportMargin = 8;
  const anchorInset = 16;
  const availableWidth = Math.max(
    280,
    Math.min(anchor.width - anchorInset * 2, viewport.width - viewportMargin * 2),
  );
  const availableHeight = Math.max(
    240,
    Math.min(anchor.height - anchorInset * 2, viewport.height - viewportMargin * 2),
  );
  const width = Math.min(960, availableWidth);
  const height = Math.min(760, availableHeight);
  return fitViewerGeometry({
    x: Math.round(anchor.left + (anchor.width - width) / 2),
    y: Math.round(anchor.top + (anchor.height - height) / 2),
    width,
    height,
  });
}

function initialViewerGeometry(sessionId: string | null): ViewerGeometry {
  if (typeof window === "undefined") {
    return { x: 24, y: 64, width: 860, height: 700 };
  }
  const anchorRect = findViewerAnchor(sessionId)?.getBoundingClientRect();
  const anchor = anchorRect ?? {
    left: 0,
    top: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  };
  return calculateInitialViewerGeometry(anchor, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
}

function fitViewerGeometry(geometry: ViewerGeometry): ViewerGeometry {
  if (typeof window === "undefined") {
    return geometry;
  }
  const margin = 8;
  const width = Math.min(geometry.width, Math.max(280, window.innerWidth - margin * 2));
  const height = Math.min(geometry.height, Math.max(240, window.innerHeight - margin * 2));
  return {
    x: clamp(geometry.x, margin, window.innerWidth - width - margin),
    y: clamp(geometry.y, margin, window.innerHeight - height - margin),
    width,
    height,
  };
}

export function InspectorFileDetailDialog(props: {
  sessionId: string | null;
  workspaceRoot: string;
  selection: FileDetailSelection;
  presentation?: "floating" | "pane" | "pane-window";
  paneWindowGeometry?: PaneWindowVerticalGeometry | null;
  onPaneWindowGeometryChange?: Dispatch<
    SetStateAction<PaneWindowVerticalGeometry | null>
  >;
  onCollapse?: () => void;
  onPresentationChange?: (presentation: "pane" | "pane-window") => void;
  onRefreshChanges: () => void;
  onClose: () => void;
}) {
  const [diffContent, setDiffContent] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffTruncated, setDiffTruncated] = useState(false);
  const [fileContent, setFileContent] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [binary, setBinary] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [mimeType, setMimeType] = useState<string | undefined>(undefined);
  const [contentBase64, setContentBase64] = useState<string | undefined>(undefined);
  const [notebookPreview, setNotebookPreview] = useState<NotebookPreviewData | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);
  const [fileActionPending, setFileActionPending] = useState<"stage" | "unstage" | null>(null);
  const [stagedOverride, setStagedOverride] = useState<boolean | undefined>(undefined);
  const [displayMode, setDisplayMode] = useState<"file" | "diff">(
    props.selection.source === "changes" || props.selection.source === "turn_changes"
      ? "diff"
      : "file",
  );
  const [wrapLines, setWrapLines] = useState(() => readDiffPreferences().wrapLines);
  const [hideWhitespace, setHideWhitespace] = useState(() => readDiffPreferences().hideWhitespace);
  const [diffLayout, setDiffLayout] = useState<DiffLayout>(
    () => readDiffPreferences().diffLayout,
  );
  const [geometry, setGeometry] = useState<ViewerGeometry>(() => initialViewerGeometry(props.sessionId));
  const [internalPaneWindowGeometry, setInternalPaneWindowGeometry] =
    useState<PaneWindowVerticalGeometry | null>(null);
  const paneWindowGeometry =
    props.paneWindowGeometry === undefined
      ? internalPaneWindowGeometry
      : props.paneWindowGeometry;
  const setPaneWindowGeometry =
    props.onPaneWindowGeometryChange ?? setInternalPaneWindowGeometry;
  const interactionRef = useRef<ViewerInteraction | null>(null);
  const paneWindowResizeRef = useRef<PaneWindowResizeInteraction | null>(null);
  const paneWindowContentRef = useRef<HTMLDivElement | null>(null);
  const userAdjustedGeometryRef = useRef(false);
  const isLocalLinkedFile = props.selection.source === "local";
  const isTurnChange = props.selection.source === "turn_changes";
  const paneWindow = props.presentation === "pane-window";
  const floating = props.presentation === undefined || props.presentation === "floating";
  const effectiveSessionId = props.selection.sessionId ?? props.sessionId;

  useEffect(() => {
    if (!floating) {
      return;
    }
    const finishInteraction = () => {
      interactionRef.current = null;
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
    const handlePointerMove = (event: PointerEvent) => {
      const interaction = interactionRef.current;
      if (!interaction) return;
      const dx = event.clientX - interaction.startX;
      const dy = event.clientY - interaction.startY;
      const start = interaction.geometry;
      const margin = 8;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const minimumWidth = Math.min(VIEWER_MIN_WIDTH, viewportWidth - margin * 2);
      const minimumHeight = Math.min(VIEWER_MIN_HEIGHT, viewportHeight - margin * 2);

      if (interaction.mode === "move") {
        setGeometry({
          ...start,
          x: clamp(start.x + dx, margin, viewportWidth - start.width - margin),
          y: clamp(start.y + dy, margin, viewportHeight - start.height - margin),
        });
        return;
      }

      const direction = interaction.direction ?? "se";
      let left = start.x;
      let top = start.y;
      let right = start.x + start.width;
      let bottom = start.y + start.height;
      if (direction.includes("w")) left = clamp(start.x + dx, margin, right - minimumWidth);
      if (direction.includes("e")) right = clamp(start.x + start.width + dx, left + minimumWidth, viewportWidth - margin);
      if (direction.includes("n")) top = clamp(start.y + dy, margin, bottom - minimumHeight);
      if (direction.includes("s")) bottom = clamp(start.y + start.height + dy, top + minimumHeight, viewportHeight - margin);
      setGeometry({ x: left, y: top, width: right - left, height: bottom - top });
    };
    const handleResize = () =>
      setGeometry((current) =>
        userAdjustedGeometryRef.current
          ? fitViewerGeometry(current)
          : initialViewerGeometry(props.sessionId),
      );
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishInteraction);
    window.addEventListener("pointercancel", finishInteraction);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishInteraction);
      window.removeEventListener("pointercancel", finishInteraction);
      window.removeEventListener("resize", handleResize);
      finishInteraction();
    };
  }, [floating, props.sessionId]);

  useEffect(() => {
    if (!paneWindow) {
      return;
    }
    const finishResize = () => {
      paneWindowResizeRef.current = null;
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
    const handlePointerMove = (event: PointerEvent) => {
      const interaction = paneWindowResizeRef.current;
      if (!interaction) return;
      setPaneWindowGeometry(
        resizePaneWindowVertically(
          interaction.geometry,
          interaction.direction,
          event.clientY - interaction.startY,
          interaction.boundsHeight,
        ),
      );
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      finishResize();
    };
  }, [paneWindow]);

  const paneWindowGeometryAdjusted = paneWindowGeometry !== null;
  useEffect(() => {
    if (!paneWindow || !paneWindowGeometryAdjusted) {
      return;
    }
    const bounds = paneWindowContentRef.current?.offsetParent;
    if (!(bounds instanceof HTMLElement)) {
      return;
    }
    const fitToBounds = () => {
      const boundsHeight = bounds.getBoundingClientRect().height;
      setPaneWindowGeometry((current) =>
        current
          ? fitPaneWindowVerticalGeometry(current, boundsHeight)
          : current,
      );
    };
    fitToBounds();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", fitToBounds);
      return () => window.removeEventListener("resize", fitToBounds);
    }
    const observer = new ResizeObserver(fitToBounds);
    observer.observe(bounds);
    return () => observer.disconnect();
  }, [paneWindow, paneWindowGeometryAdjusted]);

  useEffect(() => {
    if (!floating) {
      return;
    }
    const anchor = findViewerAnchor(props.sessionId);
    if (!anchor) return;
    const recenter = () => {
      if (!userAdjustedGeometryRef.current) {
        setGeometry(initialViewerGeometry(props.sessionId));
      }
    };
    recenter();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(recenter);
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [floating, props.sessionId]);

  const beginInteraction = (
    event: ReactPointerEvent,
    mode: ViewerInteraction["mode"],
    direction?: ResizeDirection,
  ) => {
    if (!floating || event.button !== 0) return;
    event.preventDefault();
    userAdjustedGeometryRef.current = true;
    interactionRef.current = {
      mode,
      ...(direction ? { direction } : {}),
      startX: event.clientX,
      startY: event.clientY,
      geometry,
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor =
      mode === "move"
        ? "move"
        : direction === "n" || direction === "s"
          ? "ns-resize"
          : direction === "e" || direction === "w"
            ? "ew-resize"
            : direction === "ne" || direction === "sw"
              ? "nesw-resize"
          : "nwse-resize";
  };

  const beginPaneWindowResize = (
    event: ReactPointerEvent,
    direction: PaneWindowResizeDirection,
  ) => {
    if (!paneWindow || event.button !== 0) return;
    const content = paneWindowContentRef.current;
    const bounds = content?.offsetParent;
    if (!content || !(bounds instanceof HTMLElement)) return;
    event.preventDefault();
    event.stopPropagation();
    const contentRect = content.getBoundingClientRect();
    const boundsRect = bounds.getBoundingClientRect();
    const nextGeometry = fitPaneWindowVerticalGeometry(
      {
        top: contentRect.top - boundsRect.top,
        height: contentRect.height,
      },
      boundsRect.height,
    );
    setPaneWindowGeometry(nextGeometry);
    paneWindowResizeRef.current = {
      direction,
      startY: event.clientY,
      geometry: nextGeometry,
      boundsHeight: boundsRect.height,
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ns-resize";
  };

  useEffect(() => {
    setDisplayMode(
      props.selection.source === "changes" || props.selection.source === "turn_changes"
        ? "diff"
        : "file",
    );
    setStagedOverride(undefined);
  }, [
    props.selection.baseBranch,
    props.selection.path,
    props.selection.source,
    props.selection.staged,
  ]);

  const effectiveStaged = stagedOverride ?? props.selection.staged;

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    writeDiffPreferences({ wrapLines, hideWhitespace, diffLayout });
  }, [diffLayout, hideWhitespace, wrapLines]);

  useEffect(() => {
    let cancelled = false;
    if (isLocalLinkedFile) {
      setDiffContent("");
      setDiffLoading(false);
      setDiffError(null);
      setDiffTruncated(false);
    } else {
      setDiffLoading(true);
      setDiffError(null);
      setDiffTruncated(false);
      const diffPromise = isTurnChange
        ? effectiveSessionId && props.selection.turnId
          ? readTurnFileDiff(
              effectiveSessionId,
              props.selection.turnId,
              props.selection.path,
            )
          : Promise.reject(new Error("This turn no longer has a resolvable diff target."))
        : effectiveSessionId
          ? readGitDiff(effectiveSessionId, props.selection.path, {
              ...(effectiveStaged !== undefined ? { staged: effectiveStaged } : {}),
              ...(props.selection.baseBranch
                ? { baseBranch: props.selection.baseBranch }
                : {}),
              ignoreWhitespace: hideWhitespace,
              ...(props.workspaceRoot ? { scopeRoot: props.workspaceRoot } : {}),
            })
          : readWorkspaceGitDiff(props.workspaceRoot, props.selection.path, {
              ...(effectiveStaged !== undefined ? { staged: effectiveStaged } : {}),
              ...(props.selection.baseBranch
                ? { baseBranch: props.selection.baseBranch }
                : {}),
              ignoreWhitespace: hideWhitespace,
            });
      diffPromise
        .then((response) => {
          if (!cancelled) {
            setDiffContent(response.diff);
            setDiffTruncated(
              isTurnChange &&
                "truncated" in response &&
                response.truncated === true,
            );
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setDiffError(
              isTurnChange
                ? getTurnArtifactErrorMessage(error)
                : error instanceof Error
                  ? error.message
                  : String(error),
            );
          }
        })
        .finally(() => {
          if (!cancelled) {
            setDiffLoading(false);
          }
        });
    }

    setFileError(null);
    setBinary(false);
    setTruncated(false);
    setMimeType(undefined);
    setContentBase64(undefined);
    setNotebookPreview(undefined);
    if (isTurnChange) {
      // A turn artifact freezes the authoritative turn diff, not the file at
      // that historical point. Reading the workspace file here would mix
      // later edits into the turn-scoped view.
      setFileContent("");
      setFileLoading(false);
    } else {
      setFileLoading(true);
      const filePromise = isLocalLinkedFile
        ? readHostFile(props.selection.path)
        : effectiveSessionId
          ? readSessionFile(effectiveSessionId, props.selection.path, {
              ...(props.workspaceRoot ? { scopeRoot: props.workspaceRoot } : {}),
            })
          : readWorkspaceFile(props.workspaceRoot, props.selection.path);
      filePromise
        .then((response) => {
          if (!cancelled) {
            setFileContent(response.content);
            setBinary(response.binary);
            setTruncated(Boolean(response.truncated));
            setMimeType(response.mimeType);
            setContentBase64(response.contentBase64);
            setNotebookPreview(response.notebookPreview);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setFileError(error instanceof Error ? error.message : String(error));
          }
        })
        .finally(() => {
          if (!cancelled) {
            setFileLoading(false);
          }
        });
    }

    return () => {
      cancelled = true;
    };
  }, [
    effectiveStaged,
    effectiveSessionId,
    hideWhitespace,
    isLocalLinkedFile,
    isTurnChange,
    props.selection.baseBranch,
    props.selection.path,
    props.selection.turnId,
    props.workspaceRoot,
    reloadToken,
  ]);

  const diffRows = useMemo(() => buildDiffRows(diffContent), [diffContent]);
  const diffSummary = useMemo(() => summarizeDiffRows(diffRows), [diffRows]);
  const hasDiff = diffRows.length > 0;
  const shouldShowFileTab =
    !isTurnChange &&
    (props.selection.source === "files" ||
      isLocalLinkedFile ||
      !diffSummary.isPureAddition);
  const displayPath = isLocalLinkedFile
    ? props.selection.path
    : getDisplayPath(props.selection.path, props.workspaceRoot);
  const fileName = props.selection.path.split("/").pop() || props.selection.path;
  const filePreviewKind = resolveFilePreviewKind(props.selection.path, mimeType);
  const selectionScopeLabel = isTurnChange
    ? "This turn"
    : props.selection.baseBranch
      ? props.selection.baselineIsCurrent
        ? "Uncommitted"
        : props.selection.comparisonMode === "merge_base"
          ? `Since ${props.selection.baseBranch} merge-base`
          : `Compared with ${props.selection.baseBranch}`
      : getChangeScopeLabel(effectiveStaged);
  const isBinaryChange = props.selection.source === "changes" && props.selection.binary === true;
  const showDiffUnavailable = isBinaryChange && !hasDiff && !diffLoading && !diffError;
  const canApplyGitFileAction =
    Boolean(effectiveSessionId) &&
    props.selection.source === "changes" &&
    !props.selection.baseBranch;

  const handleApplyFileAction = async (action: "stage" | "unstage") => {
    if (!effectiveSessionId) {
      return;
    }
    setFileActionPending(action);
    try {
      await applyGitFileAction(effectiveSessionId, {
        path: props.selection.path,
        action,
        ...(effectiveStaged !== undefined ? { staged: effectiveStaged } : {}),
      });
      setStagedOverride(action === "stage");
      props.onRefreshChanges();
      setReloadToken((value) => value + 1);
    } finally {
      setFileActionPending((current) => (current === action ? null : current));
    }
  };

  const dialogContent = (
    <Dialog.Content
          ref={paneWindowContentRef}
          data-inspector-file-viewer="true"
          data-file-viewer-presentation={
            floating ? "floating" : paneWindow ? "pane-window" : "pane"
          }
          data-testid="inspector-file-viewer"
          style={
            floating
              ? {
                  left: geometry.x,
                  top: geometry.y,
                  width: geometry.width,
                  height: geometry.height,
                }
              : paneWindow
                ? paneWindowGeometry
                  ? {
                      right: "1rem",
                      top: paneWindowGeometry.top,
                      width: PANE_WINDOW_DEFAULT_WIDTH,
                      height: paneWindowGeometry.height,
                    }
                  : {
                      right: "1rem",
                      top: "calc(50% + 1rem)",
                      width: PANE_WINDOW_DEFAULT_WIDTH,
                      height: PANE_WINDOW_DEFAULT_HEIGHT,
                      transform: "translateY(-50%)",
                    }
              : undefined
          }
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => event.preventDefault()}
          className={
            floating
              ? "fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl focus:outline-none max-md:!inset-0 max-md:!h-[100dvh] max-md:!w-screen max-md:!max-w-none max-md:!rounded-none max-md:!border-0 max-md:!pt-[env(safe-area-inset-top)] max-md:!pb-[env(safe-area-inset-bottom)]"
              : paneWindow
                ? "pointer-events-auto absolute z-[30] flex flex-col overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl focus:outline-none"
              : "pointer-events-auto absolute inset-x-0 bottom-0 top-8 z-[30] flex flex-col overflow-hidden border-t border-[var(--app-border)] bg-[var(--app-bg)] shadow-xl focus:outline-none"
          }
        >
          <div className="flex items-start justify-between gap-4 border-b border-[var(--app-border)] px-4 py-3 md:px-5 md:py-4">
            <div className="min-w-0 flex-1">
              <div
                data-testid="inspector-file-viewer-drag-handle"
                className={floating ? "cursor-move touch-none select-none" : "select-none"}
                onPointerDown={
                  floating ? (event) => beginInteraction(event, "move") : undefined
                }
                title={floating ? "Drag to move the file viewer" : undefined}
              >
                <Dialog.Title className="truncate text-base font-semibold text-[var(--app-fg)]">
                  {fileName}
                </Dialog.Title>
              </div>
              <div
                data-testid="inspector-file-viewer-path"
                className="mt-1 flex cursor-text select-text flex-wrap items-center gap-2 text-xs text-[var(--app-hint)]"
              >
                <Dialog.Description className="min-w-0 truncate" title={displayPath}>
                  {displayPath}
                </Dialog.Description>
                {selectionScopeLabel ? (
                  <span className="rounded border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[11px] text-[var(--app-fg)]">
                    {selectionScopeLabel}
                  </span>
                ) : null}
                {props.selection.status ? (
                  <span
                    className={`rounded border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[11px] ${getChangedFileStatusTone(props.selection.status)}`}
                  >
                    {getChangedFileStatusLabel(props.selection.status)}
                  </span>
                ) : null}
                {isBinaryChange ? (
                  <span className="rounded border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[11px] text-[var(--app-fg)]">
                    Binary
                  </span>
                ) : null}
              </div>
              {props.selection.oldPath ? (
                <div className="mt-1 cursor-text select-text truncate text-xs text-[var(--app-hint)]">
                  {props.selection.oldPath} -&gt; {props.selection.path}
                </div>
              ) : null}
            </div>
            {!floating && props.onCollapse ? (
              <button
                type="button"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                onClick={props.onCollapse}
                aria-label="Collapse file viewer"
                title="Collapse file viewer"
              >
                <Minus size={16} />
              </button>
            ) : null}
            {!floating && props.onPresentationChange ? (
              <button
                type="button"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                onClick={() =>
                  props.onPresentationChange?.(paneWindow ? "pane" : "pane-window")
                }
                aria-label={
                  paneWindow
                    ? "Maximize file viewer within pane"
                    : "Restore file viewer window"
                }
                title={
                  paneWindow
                    ? "Maximize within pane"
                    : "Restore window"
                }
              >
                {paneWindow ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
              </button>
            ) : null}
            <Dialog.Close asChild>
              <button
                type="button"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                aria-label="Close"
                title="Close"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          {hasDiff && shouldShowFileTab ? (
            <div className="border-b border-[var(--app-border)] px-3 py-2 md:px-5 md:py-3">
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
                <SegmentedControl size="compact" className="flex w-full gap-1 md:flex-1" role="tablist" ariaLabel="File detail view">
                  <SegmentedButton
                    size="compact"
                    selected={displayMode === "diff"}
                    selectedClassName={SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS}
                    onClick={() => setDisplayMode("diff")}
                    className="flex-1"
                    role="tab"
                    aria-selected={displayMode === "diff"}
                  >
                    <SegmentedButtonLabel size="compact">Diff</SegmentedButtonLabel>
                  </SegmentedButton>
                  <SegmentedButton
                    size="compact"
                    selected={displayMode === "file"}
                    selectedClassName={SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS}
                    onClick={() => setDisplayMode("file")}
                    className="flex-1"
                    role="tab"
                    aria-selected={displayMode === "file"}
                  >
                    <SegmentedButtonLabel size="compact">File</SegmentedButtonLabel>
                  </SegmentedButton>
                </SegmentedControl>
                {displayMode === "diff" ? (
                  <DiffLayoutControl value={diffLayout} onChange={setDiffLayout} />
                ) : null}
                <div className="flex flex-wrap items-center gap-1 md:shrink-0 md:justify-end">
                  {props.selection.source === "changes" && canApplyGitFileAction ? (
                    <button
                      type="button"
                      onClick={() => void handleApplyFileAction(effectiveStaged ? "unstage" : "stage")}
                      disabled={fileActionPending !== null}
                      className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                        effectiveStaged
                          ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                          : "bg-[var(--app-fg)] text-[var(--app-bg)]"
                      }`}
                    >
                      {fileActionPending === "stage"
                        ? "Adding..."
                        : fileActionPending === "unstage"
                          ? "Reverting..."
                          : effectiveStaged
                            ? "Revert add"
                            : "Git add"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setWrapLines((value) => !value)}
                    aria-pressed={wrapLines}
                    title="Wrap long lines"
                    className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                      wrapLines
                        ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                        : "text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]"
                    }`}
                  >
                    Wrap
                  </button>
                  {!isTurnChange ? (
                    <button
                      type="button"
                      onClick={() => setHideWhitespace((value) => !value)}
                      aria-pressed={hideWhitespace}
                      title="Ignore whitespace-only changes in this diff"
                      className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                        hideWhitespace
                          ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                          : "text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]"
                      }`}
                    >
                      Whitespace
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : hasDiff ? (
            <div className="border-b border-[var(--app-border)] px-3 py-2 md:px-5 md:py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <DiffLayoutControl value={diffLayout} onChange={setDiffLayout} />
                <div className="flex flex-wrap items-center justify-end gap-1">
                <button
                  type="button"
                  onClick={() => setWrapLines((value) => !value)}
                  aria-pressed={wrapLines}
                  title="Wrap long lines"
                  className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    wrapLines
                      ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                      : "text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]"
                  }`}
                >
                  Wrap
                </button>
                {!isTurnChange ? (
                  <button
                    type="button"
                    onClick={() => setHideWhitespace((value) => !value)}
                    aria-pressed={hideWhitespace}
                    title="Ignore whitespace-only changes in this diff"
                    className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                      hideWhitespace
                        ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                        : "text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]"
                    }`}
                  >
                    Whitespace
                  </button>
                ) : null}
                </div>
              </div>
            </div>
          ) : null}

          <div className="flex min-h-0 flex-1 flex-col overflow-auto rah-scroll-code scrollbar-stable p-3 md:p-5">
            {displayMode === "diff" ? (
              <FileInspectionDiffSurface
                path={props.selection.path}
                rows={diffRows}
                loading={diffLoading}
                error={diffError}
                truncated={diffTruncated}
                binary={showDiffUnavailable}
                wrapLines={wrapLines}
                layout={diffLayout}
                emptyLabel="No diff for this file."
                errorPrefix="Diff unavailable: "
                truncatedLabel="This diff exceeded the stored per-turn limit. Showing the available prefix."
              />
            ) : fileLoading ? (
              <div className="flex items-center gap-2 text-sm text-[var(--app-hint)]">
                <LoaderCircle size={14} className="animate-spin" />
                Loading file…
              </div>
            ) : fileError ? (
              <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-warning-bg)] p-3 text-xs text-[var(--app-hint)]">
                Failed to read file: {fileError}
              </div>
            ) : filePreviewKind === "image" ? (
              <ImageFilePreview
                path={props.selection.path}
                content={fileContent}
                {...(contentBase64 ? { contentBase64 } : {})}
                {...(mimeType ? { mimeType } : {})}
                truncated={truncated}
              />
            ) : binary ? (
              <div className="text-sm text-[var(--app-hint)]">This file looks binary and cannot be previewed.</div>
            ) : filePreviewKind === "table" ? (
              <DelimitedTablePreview
                path={props.selection.path}
                content={fileContent}
                truncated={truncated}
              />
            ) : filePreviewKind === "notebook" ? (
              <NotebookPreview
                path={props.selection.path}
                content={fileContent}
                truncated={truncated}
                {...(notebookPreview ? { notebookPreview } : {})}
              />
            ) : filePreviewKind === "markdown" ? (
              <MarkdownFilePreview
                path={props.selection.path}
                content={fileContent}
                truncated={truncated}
                wrapLines={wrapLines}
              />
            ) : filePreviewKind === "html" ? (
              <HtmlFilePreview
                path={props.selection.path}
                content={fileContent}
                truncated={truncated}
                wrapLines={wrapLines}
              />
            ) : (
              <div className="flex h-full min-h-0 flex-col gap-2">
                {truncated ? (
                  <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2 text-[11px] text-[var(--app-hint)]">
                    Showing the first part of a large file.
                  </div>
                ) : null}
                <FileContentDisplay
                  path={props.selection.path}
                  content={fileContent || "File is empty."}
                  wrapLines={wrapLines}
                  fillAvailable
                />
              </div>
            )}
          </div>
          {floating ? RESIZE_HANDLES.map((handle) => (
            <div
              key={handle.direction}
              role="separator"
              aria-label={`Resize file viewer ${handle.direction}`}
              data-resize-direction={handle.direction}
              className={`absolute z-10 touch-none max-md:hidden ${handle.className}`}
              onPointerDown={(event) => beginInteraction(event, "resize", handle.direction)}
            />
          )) : paneWindow ? (
            <>
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize pane file viewer from top"
                data-pane-window-resize-direction="n"
                className="absolute left-3 right-3 top-0 z-10 h-2 cursor-ns-resize touch-none"
                onPointerDown={(event) => beginPaneWindowResize(event, "n")}
              />
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize pane file viewer from bottom"
                data-pane-window-resize-direction="s"
                className="absolute bottom-0 left-3 right-3 z-10 h-2 cursor-ns-resize touch-none"
                onPointerDown={(event) => beginPaneWindowResize(event, "s")}
              />
            </>
          ) : null}
        </Dialog.Content>
  );

  return (
    <Dialog.Root open modal={false} onOpenChange={(open) => (!open ? props.onClose() : undefined)}>
      {floating ? <Dialog.Portal>{dialogContent}</Dialog.Portal> : dialogContent}
    </Dialog.Root>
  );
}
