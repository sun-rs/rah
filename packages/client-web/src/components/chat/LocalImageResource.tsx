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
    useNearViewport<HTMLSpanElement>();

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
        if (!response.contentBase64 || !response.mimeType?.startsWith("image/")) {
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
      onError={() => {
        setSrc(null);
        setFailed(true);
      }}
      className={
        props.mode === "compact"
          ? "h-full w-full object-cover"
          : `prose-chat-image-thumbnail ${
              props.path
                ? "prose-chat-image-thumbnail-local"
                : "prose-chat-image-thumbnail-remote"
            }`
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
      <span
        ref={previewHostRef}
        className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[var(--app-subtle-bg)]"
        data-image-load-failed={failed ? "true" : undefined}
      >
        {image}
      </span>
    );
  }

  const title = props.path ?? props.url ?? props.alt ?? "Image";
  const canOpen = Boolean((props.path && props.onOpenLocalFile) || props.url);
  const className =
    "prose-chat-image-preview inline-flex max-w-full items-center justify-center overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-0 text-left shadow-sm";
  const imageState = loading ? "loading" : failed ? "failed" : "ready";
  const sourceKind = props.path ? "local" : "remote";

  if (!canOpen) {
    return (
      <span ref={previewHostRef} className="prose-chat-image-preview-host">
        <span
          className={className}
          title={title}
          data-testid="conversation-inline-image"
          data-image-source-kind={sourceKind}
          data-image-state={imageState}
          data-image-load-failed={failed ? "true" : undefined}
        >
          {image}
        </span>
      </span>
    );
  }

  return (
    <span ref={previewHostRef} className="prose-chat-image-preview-host">
      <button
        type="button"
        className={`${className} cursor-zoom-in transition-colors hover:border-[var(--app-muted)]`}
        title={props.path ? `Open in Inspector: ${props.path}` : title}
        aria-label={props.alt ?? title}
        data-testid="conversation-inline-image"
        data-image-source-kind={sourceKind}
        data-image-state={imageState}
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
    </span>
  );
}
