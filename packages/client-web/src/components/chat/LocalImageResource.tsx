import { useEffect, useState } from "react";
import { Image as ImageIcon, LoaderCircle } from "lucide-react";
import { readHostFile } from "../../api";
import { useNearViewport } from "./useNearViewport";

function imageDataUrl(contentBase64: string, mimeType: string | undefined): string {
  return `data:${mimeType ?? "image/png"};base64,${contentBase64}`;
}

export function LocalImageResource(props: {
  alt?: string;
  mode: "compact" | "inline";
  onOpenLocalFile?: (path: string) => void;
  path?: string;
  url?: string;
}) {
  const [src, setSrc] = useState<string | null>(props.url ?? null);
  const [loading, setLoading] = useState(Boolean(props.path && !props.url));
  const [failed, setFailed] = useState(false);
  const { ref: previewHostRef, nearViewport } =
    useNearViewport<HTMLDivElement>();

  useEffect(() => {
    if (!props.path || props.url) {
      setSrc(props.url ?? null);
      setLoading(false);
      setFailed(false);
      return;
    }
    if (!nearViewport) {
      return;
    }

    let cancelled = false;
    setSrc(null);
    setLoading(true);
    setFailed(false);
    void readHostFile(props.path)
      .then((response) => {
        if (cancelled) {
          return;
        }
        if (!response.contentBase64) {
          setFailed(true);
          return;
        }
        setSrc(imageDataUrl(response.contentBase64, response.mimeType));
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [nearViewport, props.path, props.url]);

  const image = src ? (
    <img
      src={src}
      alt={props.alt ?? ""}
      loading="lazy"
      decoding="async"
      className={
        props.mode === "compact"
          ? "h-full w-full object-cover"
          : "max-h-[min(22rem,58vh)] max-w-full object-contain"
      }
    />
  ) : loading ? (
    <LoaderCircle
      size={props.mode === "compact" ? 14 : 18}
      className="animate-spin text-[var(--app-hint)]"
    />
  ) : (
    <ImageIcon
      size={props.mode === "compact" ? 16 : 20}
      className="text-[var(--app-hint)]"
    />
  );

  if (props.mode === "compact") {
    return (
      <div
        ref={previewHostRef}
        className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[var(--app-subtle-bg)]"
        data-image-load-failed={failed ? "true" : undefined}
      >
        {image}
      </div>
    );
  }

  const title = props.path ?? props.url ?? props.alt ?? "Image";
  const canOpen = Boolean((props.path && props.onOpenLocalFile) || props.url);
  const className =
    "prose-chat-image-preview my-3 flex min-h-24 max-w-full items-center justify-center overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-1.5 text-left";

  if (!canOpen) {
    return (
      <div
        ref={previewHostRef}
        className={className}
        title={title}
        data-testid="conversation-inline-image"
        data-image-load-failed={failed ? "true" : undefined}
      >
        {image}
      </div>
    );
  }

  return (
    <div ref={previewHostRef} className="my-3 max-w-full">
      <button
        type="button"
        className={`${className} my-0 cursor-zoom-in transition-colors hover:border-[var(--app-muted)]`}
        title={props.path ? `Open in Inspector: ${props.path}` : title}
        aria-label={props.alt ?? title}
        data-testid="conversation-inline-image"
        data-image-load-failed={failed ? "true" : undefined}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (props.path) {
            props.onOpenLocalFile?.(props.path);
          } else if (props.url) {
            window.open(props.url, "_blank", "noopener,noreferrer");
          }
        }}
      >
        {image}
      </button>
    </div>
  );
}
