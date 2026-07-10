import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { FileCode2 } from "lucide-react";
import type { ConversationTurnNavigationItem } from "./conversation-turn-navigation";

const BASE_TICK_WIDTH_PX = 10;
const ACTIVE_TICK_WIDTH_PX = 34;
const HOVER_TICK_WIDTH_PX = 40;
const NEAR_TICK_WIDTH_PX = 22;
const SECOND_NEAR_TICK_WIDTH_PX = 15;
const PREVIEW_EDGE_GUARD_PX = 94;

type NavigatorSize = {
  width: number;
  height: number;
};

function targetTickWidth(index: number, hoveredIndex: number, active: boolean): number {
  if (hoveredIndex >= 0) {
    const distance = Math.abs(index - hoveredIndex);
    if (distance === 0) {
      return HOVER_TICK_WIDTH_PX;
    }
    if (distance === 1) {
      return Math.max(active ? ACTIVE_TICK_WIDTH_PX : 0, NEAR_TICK_WIDTH_PX);
    }
    if (distance === 2) {
      return Math.max(active ? ACTIVE_TICK_WIDTH_PX : 0, SECOND_NEAR_TICK_WIDTH_PX);
    }
  }
  return active ? ACTIVE_TICK_WIDTH_PX : BASE_TICK_WIDTH_PX;
}

function turnIndexAtPointer(
  event: ReactPointerEvent<HTMLCanvasElement>,
  itemCount: number,
): number {
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.height <= 0 || itemCount <= 0) {
    return -1;
  }
  const ratio = Math.min(0.999999, Math.max(0, (event.clientY - rect.top) / rect.height));
  return Math.min(itemCount - 1, Math.floor(ratio * itemCount));
}

export const ConversationTurnNavigator = memo(function ConversationTurnNavigator(props: {
  items: readonly ConversationTurnNavigationItem[];
  activeKeys: ReadonlySet<string>;
  onNavigate: (item: ConversationTurnNavigationItem) => void;
}) {
  const hostRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const currentWidthsRef = useRef<number[]>([]);
  const [size, setSize] = useState<NavigatorSize>({ width: 0, height: 0 });
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [themeVersion, setThemeVersion] = useState(0);
  const hoveredIndex = useMemo(
    () => props.items.findIndex((item) => item.key === hoveredKey),
    [hoveredKey, props.items],
  );
  const hoveredItem = hoveredIndex >= 0 ? props.items[hoveredIndex] : undefined;

  useEffect(() => {
    if (hoveredKey && hoveredIndex < 0) {
      setHoveredKey(null);
    }
  }, [hoveredIndex, hoveredKey]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") {
      return;
    }
    const report = () => {
      const rect = host.getBoundingClientRect();
      const next = {
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      };
      setSize((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
    };
    const observer = new ResizeObserver(report);
    observer.observe(host);
    report();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof MutationObserver === "undefined") {
      return;
    }
    const observer = new MutationObserver(() => setThemeVersion((version) => version + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host || size.width <= 0 || size.height <= 0 || props.items.length === 0) {
      return;
    }
    const deviceScale = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(size.width * deviceScale));
    const pixelHeight = Math.max(1, Math.round(size.height * deviceScale));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    const styles = getComputedStyle(host);
    const foreground = styles.getPropertyValue("--app-fg").trim() || "#09090b";
    const hint = styles.getPropertyValue("--app-hint").trim() || "#71717a";
    const tickOriginX = Math.min(6, Math.max(4, size.width * 0.15));
    const widthScale = Math.min(1, Math.max(0.55, (size.width - tickOriginX - 3) / HOVER_TICK_WIDTH_PX));
    const targetWidths = props.items.map(
      (item, index) =>
        targetTickWidth(index, hoveredIndex, props.activeKeys.has(item.key)) * widthScale,
    );
    if (currentWidthsRef.current.length !== targetWidths.length) {
      currentWidthsRef.current = targetWidths.map((width) =>
        Math.min(width, BASE_TICK_WIDTH_PX),
      );
    }
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const draw = () => {
      context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
      context.clearRect(0, 0, size.width, size.height);
      const slotHeight = size.height / props.items.length;
      for (let index = 0; index < props.items.length; index += 1) {
        const item = props.items[index]!;
        const active = props.activeKeys.has(item.key);
        const hoverDistance = hoveredIndex >= 0 ? Math.abs(index - hoveredIndex) : Number.POSITIVE_INFINITY;
        const width = currentWidthsRef.current[index] ?? BASE_TICK_WIDTH_PX;
        context.beginPath();
        context.lineCap = "round";
        context.lineWidth = Math.min(
          active || hoverDistance === 0 ? 2.5 : 2,
          Math.max(0.5, slotHeight * 0.55),
        );
        context.strokeStyle = active || hoverDistance === 0 ? foreground : hint;
        context.globalAlpha = active || hoverDistance === 0 ? 1 : hoverDistance <= 2 ? 0.62 : 0.4;
        const y = (index + 0.5) * slotHeight;
        context.moveTo(tickOriginX, y);
        context.lineTo(tickOriginX + width, y);
        context.stroke();
      }
      context.globalAlpha = 1;
    };

    const animate = () => {
      animationFrameRef.current = null;
      let settled = true;
      currentWidthsRef.current = currentWidthsRef.current.map((width, index) => {
        const target = targetWidths[index] ?? BASE_TICK_WIDTH_PX;
        if (reducedMotion || Math.abs(target - width) < 0.15) {
          return target;
        }
        settled = false;
        return width + (target - width) * 0.28;
      });
      draw();
      if (!settled) {
        animationFrameRef.current = requestAnimationFrame(animate);
      }
    };

    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    animationFrameRef.current = requestAnimationFrame(animate);
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [hoveredIndex, props.activeKeys, props.items, size, themeVersion]);

  if (props.items.length < 2) {
    return null;
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const index = turnIndexAtPointer(event, props.items.length);
    setHoveredKey(index >= 0 ? props.items[index]!.key : null);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const activeIndex = props.items.findIndex((item) => props.activeKeys.has(item.key));
      const startIndex = hoveredIndex >= 0 ? hoveredIndex : Math.max(0, activeIndex);
      const delta = event.key === "ArrowUp" ? -1 : 1;
      const nextIndex = Math.min(props.items.length - 1, Math.max(0, startIndex + delta));
      setHoveredKey(props.items[nextIndex]!.key);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && hoveredItem) {
      event.preventDefault();
      props.onNavigate(hoveredItem);
    }
  };

  const previewTop = hoveredItem
    ? Math.min(
        Math.max(
          PREVIEW_EDGE_GUARD_PX,
          ((hoveredIndex + 0.5) / props.items.length) * size.height,
        ),
        Math.max(PREVIEW_EDGE_GUARD_PX, size.height - PREVIEW_EDGE_GUARD_PX),
      )
    : 0;

  return (
    <nav
      ref={hostRef}
      className="chat-turn-navigator absolute inset-y-5 z-[20] outline-none"
      aria-label={`Conversation turns, ${props.items.length} total`}
      tabIndex={0}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setHoveredKey(null);
        }
      }}
      onFocus={() => {
        if (!hoveredKey) {
          const activeItem = [...props.items].reverse().find((item) => props.activeKeys.has(item.key));
          setHoveredKey(activeItem?.key ?? props.items.at(-1)?.key ?? null);
        }
      }}
      onKeyDown={handleKeyDown}
      onPointerLeave={() => setHoveredKey(null)}
    >
      <canvas
        ref={canvasRef}
        className="h-full w-full cursor-pointer"
        aria-hidden="true"
        onPointerMove={handlePointerMove}
        onPointerDown={(event) => {
          const index = turnIndexAtPointer(event, props.items.length);
          if (index >= 0) {
            props.onNavigate(props.items[index]!);
          }
        }}
      />
      {hoveredItem ? (
        <button
          type="button"
          className="chat-turn-navigator-preview absolute left-12 w-80 -translate-y-1/2 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-left shadow-xl transition-transform duration-150 hover:scale-[1.01]"
          style={{ top: `${previewTop}px` }}
          onClick={() => props.onNavigate(hoveredItem)}
          aria-label={`Jump to: ${hoveredItem.userPreview}`}
        >
          <div className="line-clamp-2 text-sm font-semibold leading-5 text-[var(--app-fg)]">
            {hoveredItem.userPreview}
          </div>
          {hoveredItem.assistantPreview ? (
            <div className="mt-1 line-clamp-3 text-sm leading-5 text-[var(--app-hint)]">
              {hoveredItem.assistantPreview}
            </div>
          ) : (
            <div className="mt-1 text-xs text-[var(--app-hint)]">Waiting for reply</div>
          )}
          {hoveredItem.fileNames.length > 0 ? (
            <div className="mt-2 flex min-w-0 items-center gap-2 overflow-hidden text-xs text-[var(--app-hint)]">
              {hoveredItem.fileNames.slice(0, 2).map((fileName) => (
                <span key={fileName} className="inline-flex min-w-0 items-center gap-1">
                  <FileCode2 size={12} className="shrink-0" />
                  <span className="max-w-24 truncate">{fileName}</span>
                </span>
              ))}
              {hoveredItem.fileNames.length > 2 ? (
                <span className="shrink-0">+{hoveredItem.fileNames.length - 2}</span>
              ) : null}
            </div>
          ) : null}
        </button>
      ) : null}
    </nav>
  );
});
