import type { SessionQueuedInput } from "@rah/runtime-protocol";
import {
  Check,
  CornerDownRight,
  Ellipsis,
  GripVertical,
  PanelRightOpen,
  PencilLine,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

export function ComposerInputQueue(props: {
  items: readonly SessionQueuedInput[];
  canSteer: boolean;
  onUpdate: (clientMessageId: string, text: string) => Promise<void> | void;
  onDelete: (clientMessageId: string) => Promise<void> | void;
  onReorder: (clientMessageId: string, position: number) => Promise<void> | void;
  onSteer: (clientMessageId: string) => Promise<void> | void;
  onOpenSide?: (item: SessionQueuedInput) => Promise<void> | void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState(() => new Set<string>());
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuId) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuId(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menuId]);

  if (props.items.length === 0) return null;

  const run = async (id: string, action: () => Promise<void> | void) => {
    setPendingIds((current) => new Set(current).add(id));
    try {
      await action();
    } finally {
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <div
      ref={rootRef}
      className="mb-2 overflow-visible rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-sm"
      data-testid="composer-input-queue"
    >
      {props.items.map((item, index) => {
        const pending = pendingIds.has(item.clientMessageId) || item.state === "submitting";
        const editing = editingId === item.clientMessageId;
        return (
          <div
            key={item.clientMessageId}
            className={`relative flex min-h-11 items-center gap-1.5 px-2.5 py-1.5 ${
              index > 0 ? "border-t border-[var(--app-border)]" : ""
            }`}
            onDragOver={(event) => {
              if (draggedId && draggedId !== item.clientMessageId) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (draggedId && draggedId !== item.clientMessageId) {
                void run(draggedId, () => props.onReorder(draggedId, index + 1));
              }
              setDraggedId(null);
            }}
          >
            <button
              type="button"
              draggable={!pending}
              disabled={pending}
              className="inline-flex h-8 w-6 shrink-0 cursor-grab items-center justify-center text-[var(--app-muted)] hover:text-[var(--app-fg)] disabled:cursor-default disabled:opacity-40 active:cursor-grabbing"
              aria-label={`Reorder queued message ${index + 1}`}
              title="Drag to reorder · use arrow keys to move"
              onDragStart={(event) => {
                setDraggedId(item.clientMessageId);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => setDraggedId(null)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                const position = event.key === "ArrowUp" ? index : index + 2;
                if (position >= 1 && position <= props.items.length) {
                  void run(item.clientMessageId, () =>
                    props.onReorder(item.clientMessageId, position),
                  );
                }
              }}
            >
              <GripVertical size={15} />
            </button>

            <CornerDownRight size={15} className="shrink-0 text-[var(--app-muted)]" />
            {editing ? (
              <input
                autoFocus
                value={editText}
                disabled={pending}
                onChange={(event) => setEditText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setEditingId(null);
                  if (event.key === "Enter" && editText.trim()) {
                    event.preventDefault();
                    void run(item.clientMessageId, async () => {
                      await props.onUpdate(item.clientMessageId, editText.trim());
                      setEditingId(null);
                    });
                  }
                }}
                className="min-w-0 flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1 text-sm text-[var(--app-fg)] outline-none focus:border-[var(--app-accent)]"
                aria-label="Edit queued message"
              />
            ) : (
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--app-fg)]">
                {item.text || (item.attachments?.length ? "Attachment message" : "Empty message")}
              </span>
            )}

            {editing ? (
              <>
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]"
                  aria-label="Cancel editing"
                >
                  <X size={15} />
                </button>
                <button
                  type="button"
                  disabled={pending || !editText.trim()}
                  onClick={() =>
                    void run(item.clientMessageId, async () => {
                      await props.onUpdate(item.clientMessageId, editText.trim());
                      setEditingId(null);
                    })
                  }
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-accent)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-40"
                  aria-label="Save queued message"
                >
                  <Check size={15} />
                </button>
              </>
            ) : (
              <>
                {props.canSteer ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      void run(item.clientMessageId, () =>
                        props.onSteer(item.clientMessageId),
                      )
                    }
                    className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-sm font-medium text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40"
                    title="Send into the current run without interrupting it"
                  >
                    <CornerDownRight size={15} />
                    <span>Guide</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    void run(item.clientMessageId, () =>
                      props.onDelete(item.clientMessageId),
                    )
                  }
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-danger-bg)] hover:text-[var(--app-danger)] disabled:opacity-40"
                  aria-label="Delete queued message"
                >
                  <Trash2 size={15} />
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setMenuId((current) => current === item.clientMessageId ? null : item.clientMessageId)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40"
                  aria-label="Queued message actions"
                  aria-expanded={menuId === item.clientMessageId}
                >
                  <Ellipsis size={17} />
                </button>
              </>
            )}

            {menuId === item.clientMessageId ? (
              <div className="absolute bottom-10 right-2 z-40 min-w-72 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 shadow-xl">
                <QueueMenuButton
                  icon={<PencilLine size={16} />}
                  label="Edit message"
                  onClick={() => {
                    setEditText(item.text);
                    setEditingId(item.clientMessageId);
                    setMenuId(null);
                  }}
                />
                {props.onOpenSide ? (
                  <QueueMenuButton
                    icon={<PanelRightOpen size={16} />}
                    label="Open in Side chat"
                    onClick={() => {
                      setMenuId(null);
                      void run(item.clientMessageId, () => props.onOpenSide?.(item));
                    }}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function QueueMenuButton(props: {
  icon: ReactNode;
  label: string;
  description?: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-[var(--app-fg)] outline-none hover:bg-[var(--app-subtle-bg)] focus-visible:bg-[var(--app-subtle-bg)]"
      onClick={props.onClick}
      title={props.title}
    >
      <span className="mt-0.5 text-[var(--app-hint)]">{props.icon}</span>
      <span className="min-w-0">
        <span className="block">{props.label}</span>
        {props.description ? (
          <span className="mt-0.5 block max-w-64 text-xs font-normal leading-4 text-[var(--app-hint)]">
            {props.description}
          </span>
        ) : null}
      </span>
    </button>
  );
}
