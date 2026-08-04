import { createPortal } from "react-dom";
import type { SelectedConversationText } from "../../composer-annotations";

export type SelectedTextOverlayState = {
  selection: SelectedConversationText;
  anchor: { left: number; top: number; bottom: number };
};

export function selectedTextOverlayPosition(args: {
  anchor: SelectedTextOverlayState["anchor"];
  viewportWidth: number;
  viewportHeight: number;
  estimatedWidth?: number;
  estimatedHeight?: number;
}): { left: number; top: number } {
  const inset = 8;
  const width = args.estimatedWidth ?? 184;
  const height = args.estimatedHeight ?? 42;
  const left = Math.min(
    Math.max(inset, args.anchor.left),
    Math.max(inset, args.viewportWidth - width - inset),
  );
  const preferredTop = args.anchor.top - height - 6;
  const top = preferredTop >= inset
    ? preferredTop
    : Math.min(args.anchor.bottom + 6, Math.max(inset, args.viewportHeight - height - inset));
  return { left, top };
}

function clearDocumentSelection(): void {
  window.getSelection()?.removeAllRanges();
}

export function SelectedTextOverlay(props: {
  state: SelectedTextOverlayState;
  onAddToTask: (selection: SelectedConversationText) => void;
  onMoreDetails: (selection: SelectedConversationText) => void;
  onDismiss: () => void;
}) {
  if (typeof document === "undefined") {
    return null;
  }
  const position = selectedTextOverlayPosition({
    anchor: props.state.anchor,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });
  const act = (action: (selection: SelectedConversationText) => void) => {
    action(props.state.selection);
    clearDocumentSelection();
    props.onDismiss();
  };

  return createPortal(
    <div
      className="fixed z-[80] flex w-fit max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-[var(--app-border)] bg-[color-mix(in_srgb,var(--app-bg)_92%,transparent)] shadow-xl backdrop-blur-md"
      style={position}
      data-testid="selected-text-overlay"
      data-selected-text-overlay="true"
      role="toolbar"
      aria-label="所选文本操作"
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className="h-10 whitespace-nowrap px-3 text-sm font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]"
        onClick={() => act(props.onAddToTask)}
      >
        添加到任务
      </button>
      <span className="my-2 w-px bg-[var(--app-border)]" aria-hidden="true" />
      <button
        type="button"
        className="h-10 whitespace-nowrap px-3 text-sm font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]"
        onClick={() => act(props.onMoreDetails)}
      >
        更多详情
      </button>
    </div>,
    document.body,
  );
}
