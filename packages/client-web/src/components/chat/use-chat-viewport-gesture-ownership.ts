import { useEffect, type RefObject } from "react";

const VIEWPORT_SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

export function useChatViewportGestureOwnership(options: {
  containerRef: RefObject<HTMLDivElement | null>;
  touchScrollYRef: RefObject<number | null>;
  pointerScrollGestureRef: RefObject<boolean>;
  releaseAnchors: () => void;
  detachBottomFollowing: () => void;
}): void {
  useEffect(() => {
    const node = options.containerRef.current;
    if (!node) {
      return;
    }
    const beginGesture = () => {
      options.releaseAnchors();
      options.pointerScrollGestureRef.current = true;
    };
    const handleWheel = (event: WheelEvent) => {
      options.releaseAnchors();
      if (event.deltaY < 0) {
        options.detachBottomFollowing();
      }
    };
    const handleTouchStart = (event: TouchEvent) => {
      beginGesture();
      options.touchScrollYRef.current = event.touches[0]?.clientY ?? null;
    };
    const handleTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? null;
      const previousY = options.touchScrollYRef.current;
      if (nextY !== null && previousY !== null && nextY - previousY > 2) {
        options.detachBottomFollowing();
      }
      options.touchScrollYRef.current = nextY;
    };
    const endGesture = () => {
      options.touchScrollYRef.current = null;
      options.pointerScrollGestureRef.current = false;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (VIEWPORT_SCROLL_KEYS.has(event.key)) {
        options.releaseAnchors();
      }
      if (
        event.key === "ArrowUp" ||
        event.key === "PageUp" ||
        event.key === "Home" ||
        (event.key === " " && event.shiftKey)
      ) {
        options.detachBottomFollowing();
      }
    };

    node.addEventListener("wheel", handleWheel, { passive: true, capture: true });
    node.addEventListener("touchstart", handleTouchStart, { passive: true, capture: true });
    node.addEventListener("touchmove", handleTouchMove, { passive: true });
    node.addEventListener("touchend", endGesture, { passive: true });
    node.addEventListener("touchcancel", endGesture, { passive: true });
    node.addEventListener("pointerdown", beginGesture, { passive: true, capture: true });
    window.addEventListener("pointerup", endGesture, { passive: true });
    window.addEventListener("pointercancel", endGesture, { passive: true });
    node.addEventListener("keydown", handleKeyDown, true);
    return () => {
      node.removeEventListener("wheel", handleWheel, true);
      node.removeEventListener("touchstart", handleTouchStart, true);
      node.removeEventListener("touchmove", handleTouchMove);
      node.removeEventListener("touchend", endGesture);
      node.removeEventListener("touchcancel", endGesture);
      node.removeEventListener("pointerdown", beginGesture, true);
      window.removeEventListener("pointerup", endGesture);
      window.removeEventListener("pointercancel", endGesture);
      node.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [
    options.containerRef,
    options.detachBottomFollowing,
    options.pointerScrollGestureRef,
    options.releaseAnchors,
    options.touchScrollYRef,
  ]);
}
