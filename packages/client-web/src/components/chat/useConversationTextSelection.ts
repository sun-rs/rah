import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import type { SelectedTextOverlayState } from "./SelectedTextOverlay";
import type { VirtualFeedWindow } from "./virtualized-feed-layout";

type ConversationTextSelectionOptions = {
  sessionId: string;
  contentRef: RefObject<HTMLDivElement | null>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  resolvedVirtualWindow: VirtualFeedWindow;
  dragActiveRef: RefObject<boolean>;
  virtualWindowLeaseRef: RefObject<VirtualFeedWindow | null>;
  pendingMeasurementRef: RefObject<boolean>;
  onReleaseVirtualWindow: () => void;
  canCapture: boolean;
};

export function useConversationTextSelection(options: ConversationTextSelectionOptions) {
  const [overlay, setOverlay] = useState<SelectedTextOverlayState | null>(null);
  const listenerCleanupRef = useRef<(() => void) | null>(null);
  const captureRafRef = useRef<number | null>(null);
  const releaseRafRef = useRef<number | null>(null);

  const reset = useCallback(() => {
    listenerCleanupRef.current?.();
    listenerCleanupRef.current = null;
    options.dragActiveRef.current = false;
    options.virtualWindowLeaseRef.current = null;
    options.pendingMeasurementRef.current = false;
    if (captureRafRef.current !== null) cancelAnimationFrame(captureRafRef.current);
    if (releaseRafRef.current !== null) cancelAnimationFrame(releaseRafRef.current);
    captureRafRef.current = null;
    releaseRafRef.current = null;
  }, [options.dragActiveRef, options.pendingMeasurementRef, options.virtualWindowLeaseRef]);

  const finishDrag = useCallback(() => {
    listenerCleanupRef.current?.();
    listenerCleanupRef.current = null;
    if (!options.dragActiveRef.current) return;
    options.dragActiveRef.current = false;
    if (releaseRafRef.current !== null) cancelAnimationFrame(releaseRafRef.current);
    // ChatThread's mouseup capture queues Range capture first. Release the
    // virtual-window lease only after that native selection has been read.
    releaseRafRef.current = requestAnimationFrame(() => {
      releaseRafRef.current = null;
      options.virtualWindowLeaseRef.current = null;
      options.pendingMeasurementRef.current = false;
      options.onReleaseVirtualWindow();
    });
  }, [
    options.dragActiveRef,
    options.onReleaseVirtualWindow,
    options.pendingMeasurementRef,
    options.virtualWindowLeaseRef,
  ]);

  const handleMouseDownCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.defaultPrevented) return;
    setOverlay(null);
    const target = event.target as HTMLElement | null;
    const interactiveTarget = target?.closest(
      "button,a,input,textarea,select,summary,[role='button'],[contenteditable='true']",
    );
    if (interactiveTarget && !target?.closest("[data-selectable-conversation-text='true']")) {
      return;
    }
    finishDrag();
    const startX = event.clientX;
    const startY = event.clientY;
    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (
        options.dragActiveRef.current ||
        Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) < 4
      ) return;
      if (releaseRafRef.current !== null) cancelAnimationFrame(releaseRafRef.current);
      releaseRafRef.current = null;
      options.virtualWindowLeaseRef.current = options.resolvedVirtualWindow;
      options.dragActiveRef.current = true;
    };
    const cleanup = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", finishDrag);
      window.removeEventListener("blur", finishDrag);
    };
    listenerCleanupRef.current = cleanup;
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", finishDrag);
    window.addEventListener("blur", finishDrag);
  }, [
    finishDrag,
    options.dragActiveRef,
    options.resolvedVirtualWindow,
    options.virtualWindowLeaseRef,
  ]);

  const capture = useCallback(() => {
    captureRafRef.current = null;
    const selection = window.getSelection();
    const contentNode = options.contentRef.current;
    if (!options.canCapture || !selection || selection.isCollapsed || !selection.rangeCount || !contentNode) {
      setOverlay(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!contentNode.contains(range.startContainer) || !contentNode.contains(range.endContainer)) {
      setOverlay(null);
      return;
    }
    const sourceForNode = (node: Node) =>
      (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)
        ?.closest<HTMLElement>("[data-selection-source='conversation-message']") ?? null;
    const startSource = sourceForNode(range.startContainer);
    const endSource = sourceForNode(range.endContainer);
    const text = selection.toString().trim();
    const rect = range.getClientRects().item(0) ?? range.getBoundingClientRect();
    if (!startSource || startSource !== endSource || !text || (rect.width <= 0 && rect.height <= 0)) {
      setOverlay(null);
      return;
    }
    const role = startSource.dataset.selectionRole;
    setOverlay({
      selection: {
        text,
        source: {
          sessionId: options.sessionId,
          ...(startSource.dataset.selectionEntryKey ? { entryKey: startSource.dataset.selectionEntryKey } : {}),
          ...(role === "assistant" || role === "user" ? { role } : {}),
        },
      },
      anchor: { left: rect.left, top: rect.top, bottom: rect.bottom },
    });
  }, [options.canCapture, options.contentRef, options.sessionId]);

  const handleMouseUpCapture = useCallback(() => {
    if (captureRafRef.current !== null) cancelAnimationFrame(captureRafRef.current);
    captureRafRef.current = requestAnimationFrame(capture);
  }, [capture]);

  useEffect(() => {
    const node = options.scrollContainerRef.current;
    if (!node) return;
    const dismiss = () => setOverlay(null);
    node.addEventListener("scroll", dismiss, { passive: true });
    window.addEventListener("resize", dismiss);
    return () => {
      node.removeEventListener("scroll", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, [options.scrollContainerRef]);

  useEffect(() => {
    setOverlay(null);
    window.getSelection()?.removeAllRanges();
    return reset;
  }, [options.sessionId, reset]);

  useEffect(() => {
    if (!overlay) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-selected-text-overlay='true']")) return;
      setOverlay(null);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [overlay]);

  return {
    overlay,
    dismiss: () => setOverlay(null),
    handleMouseDownCapture,
    handleMouseUpCapture,
  };
}
