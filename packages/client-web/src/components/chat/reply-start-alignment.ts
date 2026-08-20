export interface ReplyStartAlignmentTarget {
  entryKey: string;
  targetScrollTop: number;
}

export interface ReplyStartAlignmentController {
  alignNow(): boolean;
  clear(): void;
  dispose(): void;
  hasAnchor(): boolean;
  start(target: ReplyStartAlignmentTarget): void;
}

export function createReplyStartAlignmentController(options: {
  getContainer: () => HTMLElement | null;
  onViewportChanged: (node: HTMLElement) => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}): ReplyStartAlignmentController {
  const requestFrame =
    options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
  const cancelFrame =
    options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
  let anchorKey: string | null = null;
  let alignmentFrame: number | null = null;

  const cancelPendingFrame = () => {
    if (alignmentFrame !== null) {
      cancelFrame(alignmentFrame);
      alignmentFrame = null;
    }
  };
  const mountedAlignment = (
    node: HTMLElement,
    notifyWhenStable: boolean,
  ): { mounted: boolean; aligned: boolean } => {
    if (!anchorKey) {
      return { mounted: false, aligned: false };
    }
    const targetNode = Array.from(
      node.querySelectorAll<HTMLElement>("[data-feed-entry-key]"),
    ).find((entryNode) => entryNode.dataset.feedEntryKey === anchorKey);
    if (!targetNode) {
      return { mounted: false, aligned: false };
    }
    const delta =
      targetNode.getBoundingClientRect().top - node.getBoundingClientRect().top;
    const aligned = Math.abs(delta) < 0.5;
    if (!aligned) {
      node.scrollTop += delta;
    }
    if (!aligned || notifyWhenStable) {
      options.onViewportChanged(node);
    }
    return { mounted: true, aligned };
  };

  const clear = () => {
    anchorKey = null;
    cancelPendingFrame();
  };
  const alignNow = () => {
    const node = options.getContainer();
    return node ? mountedAlignment(node, false).mounted : false;
  };
  const start = (target: ReplyStartAlignmentTarget) => {
    cancelPendingFrame();
    anchorKey = target.entryKey;
    const node = options.getContainer();
    if (!node) {
      return;
    }
    if (!mountedAlignment(node, true).mounted) {
      node.scrollTop = target.targetScrollTop;
      options.onViewportChanged(node);
    }

    let attemptsRemaining = 8;
    const settle = () => {
      alignmentFrame = null;
      if (options.getContainer() !== node) {
        return;
      }
      const { mounted, aligned } = mountedAlignment(node, true);
      attemptsRemaining -= 1;
      if ((!mounted || !aligned) && attemptsRemaining > 0) {
        alignmentFrame = requestFrame(settle);
      }
    };
    alignmentFrame = requestFrame(settle);
  };

  return {
    alignNow,
    clear,
    dispose: clear,
    hasAnchor: () => anchorKey !== null,
    start,
  };
}
