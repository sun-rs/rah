import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";

export const OVERLAY_SCROLL_AREA_LAYOUT = {
  shellClassName: "relative min-h-0 group/overlay-scroll",
  viewportClassName:
    "overflow-y-auto overscroll-y-contain rah-scroll-overlay-area",
  trackClassName:
    "absolute bottom-2 right-0 top-2 z-10 w-2 cursor-default touch-none opacity-0 transition-opacity duration-150 group-hover/overlay-scroll:opacity-100 group-focus-within/overlay-scroll:opacity-100",
  thumbClassName:
    "absolute right-0 top-0 w-1 cursor-grab rounded-full bg-[color:color-mix(in_oklab,var(--app-hint)_42%,transparent)] shadow-sm active:cursor-grabbing",
} as const;

type OverlayScrollThumb = {
  top: number;
  height: number;
  scrollTop: number;
  scrollable: number;
};

function joinClassNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) {
    return;
  }
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  (ref as { current: T | null }).current = value;
}

export function OverlayScrollArea(props: {
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
  contentClassName?: string;
  trackClassName?: string;
  thumbClassName?: string;
  edgeOffsetPx?: number;
  thumbMinHeightPx?: number;
  scrollAriaLabel?: string;
  viewportRef?: Ref<HTMLDivElement>;
  contentRef?: Ref<HTMLDivElement>;
}) {
  const viewportId = useId();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startClientY: number;
    startScrollTop: number;
  } | null>(null);
  const [thumb, setThumb] = useState<OverlayScrollThumb | null>(null);
  const [dragging, setDragging] = useState(false);
  const edgeOffsetPx = props.edgeOffsetPx ?? 8;
  const thumbMinHeightPx = props.thumbMinHeightPx ?? 24;

  const setViewportRef = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node;
    assignRef(props.viewportRef, node);
  }, [props.viewportRef]);

  const setContentRef = useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node;
    assignRef(props.contentRef, node);
  }, [props.contentRef]);

  const updateThumb = useCallback(() => {
    const node = viewportRef.current;
    if (!node) {
      setThumb(null);
      return;
    }
    const scrollable = node.scrollHeight - node.clientHeight;
    const trackHeight = Math.max(0, node.clientHeight - edgeOffsetPx * 2);
    if (scrollable <= 1 || trackHeight <= 0 || node.clientHeight <= 0) {
      setThumb(null);
      return;
    }
    const height = Math.min(
      trackHeight,
      Math.max(thumbMinHeightPx, Math.round((trackHeight * node.clientHeight) / node.scrollHeight)),
    );
    const top = Math.round(((trackHeight - height) * node.scrollTop) / scrollable);
    const nextThumb = {
      top,
      height,
      scrollTop: node.scrollTop,
      scrollable,
    };
    setThumb((current) => {
      if (
        current?.top === nextThumb.top &&
        current.height === nextThumb.height &&
        current.scrollTop === nextThumb.scrollTop &&
        current.scrollable === nextThumb.scrollable
      ) {
        return current;
      }
      return nextThumb;
    });
  }, [edgeOffsetPx, thumbMinHeightPx]);

  useEffect(() => {
    updateThumb();
    const node = viewportRef.current;
    if (!node || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(updateThumb);
    observer.observe(node);
    if (contentRef.current) {
      observer.observe(contentRef.current);
    }
    return () => observer.disconnect();
  }, [updateThumb, props.children]);

  const scrollByTrackPointer = useCallback((clientY: number) => {
    const node = viewportRef.current;
    if (!node) {
      return;
    }
    const trackHeight = Math.max(0, node.clientHeight - edgeOffsetPx * 2);
    const scrollable = node.scrollHeight - node.clientHeight;
    const thumbHeight = thumb?.height ?? 0;
    const maxThumbTop = Math.max(1, trackHeight - thumbHeight);
    const trackTop = node.getBoundingClientRect().top + edgeOffsetPx;
    const nextThumbTop = Math.max(
      0,
      Math.min(maxThumbTop, clientY - trackTop - thumbHeight / 2),
    );
    node.scrollTop = (nextThumbTop / maxThumbTop) * scrollable;
    updateThumb();
  }, [edgeOffsetPx, thumb?.height, updateThumb]);

  const onTrackPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    event.preventDefault();
    scrollByTrackPointer(event.clientY);
  }, [scrollByTrackPointer]);

  const onThumbPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const node = viewportRef.current;
    if (!node) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startClientY: event.clientY,
      startScrollTop: node.scrollTop,
    };
    setDragging(true);
  }, []);

  const onThumbPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const node = viewportRef.current;
    if (!drag || !node || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    const trackHeight = Math.max(0, node.clientHeight - edgeOffsetPx * 2);
    const scrollable = node.scrollHeight - node.clientHeight;
    const thumbHeight = thumb?.height ?? 0;
    const maxThumbTop = Math.max(1, trackHeight - thumbHeight);
    const deltaY = event.clientY - drag.startClientY;
    node.scrollTop = drag.startScrollTop + (deltaY / maxThumbTop) * scrollable;
    updateThumb();
  }, [edgeOffsetPx, thumb?.height, updateThumb]);

  const endThumbDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const onThumbKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const node = viewportRef.current;
    if (!node) {
      return;
    }
    const lineStep = 48;
    const pageStep = Math.max(48, node.clientHeight * 0.85);
    let nextScrollTop: number | null = null;
    if (event.key === "ArrowDown") {
      nextScrollTop = node.scrollTop + lineStep;
    } else if (event.key === "ArrowUp") {
      nextScrollTop = node.scrollTop - lineStep;
    } else if (event.key === "PageDown") {
      nextScrollTop = node.scrollTop + pageStep;
    } else if (event.key === "PageUp") {
      nextScrollTop = node.scrollTop - pageStep;
    } else if (event.key === "Home") {
      nextScrollTop = 0;
    } else if (event.key === "End") {
      nextScrollTop = node.scrollHeight - node.clientHeight;
    }
    if (nextScrollTop === null) {
      return;
    }
    event.preventDefault();
    node.scrollTop = Math.max(0, Math.min(node.scrollHeight - node.clientHeight, nextScrollTop));
    updateThumb();
  }, [updateThumb]);

  return (
    <div
      className={joinClassNames(OVERLAY_SCROLL_AREA_LAYOUT.shellClassName, props.className)}
      data-rah-scroll-area="overlay"
    >
      <div
        id={viewportId}
        ref={setViewportRef}
        className={joinClassNames(OVERLAY_SCROLL_AREA_LAYOUT.viewportClassName, props.viewportClassName)}
        onScroll={updateThumb}
      >
        <div ref={setContentRef} className={props.contentClassName}>
          {props.children}
        </div>
      </div>
      {thumb ? (
        <div
          className={joinClassNames(OVERLAY_SCROLL_AREA_LAYOUT.trackClassName, props.trackClassName)}
          onPointerDown={onTrackPointerDown}
          style={dragging ? { opacity: 1 } : undefined}
        >
          <div
            role="scrollbar"
            aria-controls={viewportId}
            aria-label={props.scrollAriaLabel ?? "Scroll area"}
            aria-orientation="vertical"
            aria-valuemin={0}
            aria-valuemax={Math.round(thumb.scrollable)}
            aria-valuenow={Math.round(thumb.scrollTop)}
            tabIndex={0}
            className={joinClassNames(OVERLAY_SCROLL_AREA_LAYOUT.thumbClassName, props.thumbClassName)}
            onKeyDown={onThumbKeyDown}
            onPointerDown={onThumbPointerDown}
            onPointerMove={onThumbPointerMove}
            onPointerUp={endThumbDrag}
            onPointerCancel={endThumbDrag}
            onLostPointerCapture={endThumbDrag}
            style={{
              height: thumb.height,
              transform: `translateY(${thumb.top}px)`,
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
