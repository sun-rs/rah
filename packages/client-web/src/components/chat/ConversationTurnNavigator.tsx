import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ConversationTurnNavigationItem } from "./conversation-turn-navigation";
import { conversationTurnIndexAtScrollableRailPosition } from "./conversation-turn-navigation";
import { FileResourceIcon } from "./FileResourceIcon";

const MIN_NAVIGATION_TURNS = 4;
const MARKER_ROW_HEIGHT_PX = 10;
const PREVIEW_EDGE_GUARD_PX = 94;

type ScrubState = {
  pointerId: number;
  targetIndex: number;
};

function markerWidth(index: number, activeIndex: number, interactionIndex: number | null): number {
  const interactionDistance = interactionIndex === null
    ? Number.POSITIVE_INFINITY
    : Math.abs(interactionIndex - index);
  if (interactionDistance === 0) return 30;
  if (index === activeIndex) return 26;
  if (interactionDistance === 1) return 20;
  if (interactionDistance === 2) return 13;
  if (interactionDistance === 3) return 10;
  return 7;
}

export const ConversationTurnNavigator = memo(function ConversationTurnNavigator(props: {
  items: readonly ConversationTurnNavigationItem[];
  activeKeys: ReadonlySet<string>;
  onNavigate: (item: ConversationTurnNavigationItem) => void;
}) {
  const hostRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const markerRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const scrubRef = useRef<ScrubState | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [keyboardIndex, setKeyboardIndex] = useState<number | null>(null);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const [previewTop, setPreviewTop] = useState(0);

  const activeIndex = useMemo(() => {
    const index = props.items.findIndex((item) => props.activeKeys.has(item.key));
    return index >= 0 ? index : Math.max(0, props.items.length - 1);
  }, [props.activeKeys, props.items]);
  const interactionIndex = scrubIndex ?? hoveredIndex ?? keyboardIndex;
  const previewItem = interactionIndex === null ? undefined : props.items[interactionIndex];

  useEffect(() => {
    markerRefs.current.length = props.items.length;
  }, [props.items.length]);

  const ensureIndexVisible = (index: number) => {
    const list = listRef.current;
    if (!list) return;
    const rowTop = index * MARKER_ROW_HEIGHT_PX;
    const rowBottom = rowTop + MARKER_ROW_HEIGHT_PX;
    if (rowTop < list.scrollTop) {
      list.scrollTop = rowTop;
    } else if (rowBottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = rowBottom - list.clientHeight;
    }
  };

  useEffect(() => {
    ensureIndexVisible(activeIndex);
  }, [activeIndex]);

  if (props.items.length < MIN_NAVIGATION_TURNS) {
    return null;
  }

  const updatePreviewPosition = (index: number) => {
    const host = hostRef.current;
    const marker = markerRefs.current[index];
    if (!host || !marker) return;
    const hostRect = host.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const rawTop = markerRect.top - hostRect.top + markerRect.height / 2;
    setPreviewTop(
      Math.min(
        Math.max(PREVIEW_EDGE_GUARD_PX, rawTop),
        Math.max(PREVIEW_EDGE_GUARD_PX, hostRect.height - PREVIEW_EDGE_GUARD_PX),
      ),
    );
  };

  const selectIndex = (index: number, source: "pointer" | "keyboard") => {
    if (index < 0 || index >= props.items.length) return;
    if (source === "keyboard") setKeyboardIndex(index);
    else setHoveredIndex(index);
    ensureIndexVisible(index);
    requestAnimationFrame(() => updatePreviewPosition(index));
  };

  const pointerIndex = (event: ReactPointerEvent<HTMLDivElement>): number => {
    const list = listRef.current;
    if (!list) return -1;
    const rect = list.getBoundingClientRect();
    return conversationTurnIndexAtScrollableRailPosition(
      props.items.length,
      event.clientY - rect.top,
      list.scrollTop,
      MARKER_ROW_HEIGHT_PX,
    );
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const current = keyboardIndex ?? activeIndex;
    let nextIndex: number | null = null;
    if (event.key === "ArrowUp") nextIndex = Math.max(0, current - 1);
    else if (event.key === "ArrowDown") nextIndex = Math.min(props.items.length - 1, current + 1);
    else if (event.key === "PageUp") nextIndex = Math.max(0, current - 10);
    else if (event.key === "PageDown") nextIndex = Math.min(props.items.length - 1, current + 10);
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = props.items.length - 1;
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const item = props.items[current];
      if (item) props.onNavigate(item);
      return;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    selectIndex(nextIndex, "keyboard");
  };

  return (
    <nav
      ref={hostRef}
      className="chat-turn-navigator absolute z-[20] outline-none"
      aria-label={`Conversation turns, ${props.items.length} total`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setKeyboardIndex(null);
          setHoveredIndex(null);
        }
      }}
    >
      <div
        ref={listRef}
        className="chat-turn-navigator-list rah-scroll-overlay"
        data-scrubbing={scrubRef.current ? "true" : undefined}
        onScroll={() => {
          if (interactionIndex !== null) updatePreviewPosition(interactionIndex);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const index = pointerIndex(event);
          if (index < 0) return;
          scrubRef.current = { pointerId: event.pointerId, targetIndex: index };
          event.currentTarget.setPointerCapture(event.pointerId);
          setScrubIndex(index);
          selectIndex(index, "pointer");
        }}
        onPointerMove={(event) => {
          const index = pointerIndex(event);
          if (index < 0) return;
          const scrub = scrubRef.current;
          if (scrub?.pointerId === event.pointerId) {
            scrub.targetIndex = index;
            setScrubIndex(index);
          }
          selectIndex(index, "pointer");
        }}
        onPointerUp={(event) => {
          const scrub = scrubRef.current;
          if (!scrub || scrub.pointerId !== event.pointerId) return;
          const item = props.items[scrub.targetIndex];
          scrubRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          setScrubIndex(null);
          if (item) props.onNavigate(item);
        }}
        onPointerCancel={(event) => {
          scrubRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          setScrubIndex(null);
        }}
        onPointerLeave={() => {
          if (!scrubRef.current) setHoveredIndex(null);
        }}
      >
        {props.items.map((item, index) => {
          const active = props.activeKeys.has(item.key);
          const target = interactionIndex === index;
          return (
            <div
              key={item.key}
              className="chat-turn-navigator-row"
              style={{ height: `${MARKER_ROW_HEIGHT_PX}px` }}
            >
              <button
                ref={(node) => {
                  markerRefs.current[index] = node;
                }}
                type="button"
                className="chat-turn-navigator-marker"
                style={{ width: `${markerWidth(index, activeIndex, interactionIndex)}px` }}
                data-active={active ? "true" : undefined}
                data-target={target ? "true" : undefined}
                aria-current={active ? "step" : undefined}
                aria-label={`Turn ${index + 1}: ${item.userPreview}`}
                tabIndex={-1}
                onFocus={() => selectIndex(index, "keyboard")}
                onPointerEnter={() => selectIndex(index, "pointer")}
              />
            </div>
          );
        })}
      </div>

      {previewItem ? (
        <button
          type="button"
          className="chat-turn-navigator-preview absolute left-full ml-1 w-80 max-w-[calc(100vw-1rem)] -translate-y-1/2 rounded-xl border border-[var(--app-border)] bg-[color-mix(in_srgb,var(--app-bg)_95%,transparent)] p-3 text-left shadow-xl backdrop-blur-sm transition-transform duration-150 hover:scale-[1.01]"
          style={{ top: `${previewTop}px` }}
          onClick={() => props.onNavigate(previewItem)}
          aria-label={`Jump to: ${previewItem.userPreview}`}
        >
          <div className="line-clamp-2 text-sm font-semibold leading-5 text-[var(--app-fg)]">
            {previewItem.userPreview}
          </div>
          {previewItem.assistantPreview ? (
            <div className="mt-1 line-clamp-3 text-sm leading-5 text-[var(--app-hint)]">
              {previewItem.assistantPreview}
            </div>
          ) : (
            <div className="mt-1 text-xs text-[var(--app-hint)]">Waiting for reply</div>
          )}
          {previewItem.fileNames.length > 0 ? (
            <div className="mt-2 flex min-w-0 items-center gap-3 overflow-hidden text-xs text-[var(--app-hint)]">
              {previewItem.fileNames.slice(0, 2).map((fileName) => (
                <span key={fileName} className="inline-flex min-w-0 items-center gap-1.5">
                  <FileResourceIcon path={fileName} size={12} className="shrink-0" />
                  <span className="max-w-28 truncate">{fileName}</span>
                </span>
              ))}
              {previewItem.fileNames.length > 2 ? (
                <span className="shrink-0 tabular-nums">+{previewItem.fileNames.length - 2}</span>
              ) : null}
            </div>
          ) : null}
        </button>
      ) : null}
    </nav>
  );
});
