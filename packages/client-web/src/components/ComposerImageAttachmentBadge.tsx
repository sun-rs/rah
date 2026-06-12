import { X } from "lucide-react";

export function ComposerImageAttachmentBadge(props: {
  imageUrls: readonly string[];
  onRemove?: ((index: number) => void) | undefined;
  className?: string | undefined;
}) {
  if (props.imageUrls.length <= 0) {
    return null;
  }

  return (
    <div
      className={`flex max-w-full items-center gap-1.5 overflow-visible ${props.className ?? ""}`}
      title={
        props.imageUrls.length === 1
          ? "1 pasted image"
          : `${props.imageUrls.length} pasted images`
      }
    >
      {props.imageUrls.map((url, index) => (
        <div
          key={`${url.slice(0, 48)}:${index}`}
          className="relative z-0 h-9 w-9 shrink-0 rounded-xl border-2 border-sky-500/35 bg-sky-500/10 p-0.5 shadow-sm dark:border-sky-400/35 dark:bg-sky-400/12"
        >
          <img
            src={url}
            alt={`Pasted image ${index + 1}`}
            className="h-full w-full rounded-[0.45rem] object-cover"
            draggable={false}
          />
          {props.onRemove ? (
            <button
              type="button"
              className="icon-click-feedback absolute -right-1.5 -top-1.5 z-10 inline-flex h-4 w-4 items-center justify-center rounded-full bg-sky-100 text-sky-700 shadow-sm ring-1 ring-sky-500/25 transition-colors hover:bg-sky-200 dark:bg-sky-950 dark:text-sky-200 dark:ring-sky-300/25 dark:hover:bg-sky-900"
              onClick={() => props.onRemove?.(index)}
              aria-label={`Remove pasted image ${index + 1}`}
              title="Remove image"
            >
              <X size={9} />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
