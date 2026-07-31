import type { SessionInputAttachment } from "@rah/runtime-protocol";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  File,
  Image as ImageIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { readAttachment } from "../../api";
import { copyTextToClipboard } from "../../clipboard";
import { DATA_IMAGE_URL_PATTERN } from "../../composer-image-attachments";
import { useNearViewport } from "./useNearViewport";

function visibleUserMessageContent(content: string): { text: string; imageCount: number } {
  let imageCount = 0;
  const text = content
    .replace(DATA_IMAGE_URL_PATTERN, () => {
      imageCount += 1;
      return "";
    })
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line.trim() || lines[index - 1]?.trim())
    .join("\n")
    .trim();
  return { text, imageCount };
}

const USER_MESSAGE_COLLAPSED_MAX_HEIGHT = "min(24rem, 50dvh)";
const USER_MESSAGE_PRECOLLAPSE_CHARACTERS = 1_200;
const USER_MESSAGE_PRECOLLAPSE_LINES = 16;

export function shouldPreCollapseUserMessage(text: string): boolean {
  return (
    text.length > USER_MESSAGE_PRECOLLAPSE_CHARACTERS ||
    text.split("\n").length > USER_MESSAGE_PRECOLLAPSE_LINES
  );
}

function CollapsibleUserMessageText(props: { text: string }) {
  const textRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(() => shouldPreCollapseUserMessage(props.text));

  useEffect(() => {
    setExpanded(false);
  }, [props.text]);

  useEffect(() => {
    if (expanded) {
      return;
    }
    const node = textRef.current;
    if (!node) {
      return;
    }
    const measure = () => {
      const next =
        shouldPreCollapseUserMessage(props.text) ||
        node.scrollHeight > node.clientHeight + 1;
      setOverflowing((current) => current === next ? current : next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, props.text]);

  return (
    <div>
      <div className="relative">
        <div
          ref={textRef}
          className={`chat-body-text whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${
            expanded ? "" : "overflow-hidden"
          }`}
          style={expanded ? undefined : { maxHeight: USER_MESSAGE_COLLAPSED_MAX_HEIGHT }}
          data-testid="user-message-text"
        >
          {props.text}
        </div>
        {overflowing && !expanded ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-7"
            data-testid="user-message-collapse-fade"
            style={{
              background:
                "linear-gradient(to bottom, transparent 0%, var(--user-bubble-bg) 100%)",
            }}
          />
        ) : null}
      </div>
      {overflowing ? (
        <button
          type="button"
          className="inline-flex h-5 items-center gap-0.5 rounded-sm text-xs font-medium leading-none text-[var(--app-muted)] outline-none transition-colors hover:text-[var(--app-fg)] focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--user-bubble-bg)]"
          aria-expanded={expanded}
          data-testid="user-message-expand-toggle"
          onClick={() => setExpanded((current) => !current)}
        >
          <span>{expanded ? "Show less" : "Show more"}</span>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      ) : null}
    </div>
  );
}

export function UserMessage(props: {
  content: string;
  imageCount?: number | undefined;
  attachments?: SessionInputAttachment[] | undefined;
  entryKey?: string | undefined;
  onOpenLocalFile?: ((path: string) => void) | undefined;
  onLoadDetail?: (() => Promise<void> | void) | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const detailRequestKeyRef = useRef<string | null>(null);
  const { ref: messageRef, nearViewport } = useNearViewport<HTMLDivElement>();
  const visibleContent = useMemo(
    () => visibleUserMessageContent(props.content),
    [props.content],
  );
  const attachmentImageCount = props.attachments?.filter((attachment) => attachment.kind === "image").length ?? 0;
  const imageCount = Math.max(
    props.imageCount ?? 0,
    visibleContent.imageCount,
    attachmentImageCount,
  );
  const missingImageCount = Math.max(0, imageCount - attachmentImageCount);

  useEffect(() => {
    if (!nearViewport || missingImageCount === 0 || !props.onLoadDetail) {
      return;
    }
    const requestKey = props.entryKey ?? props.content;
    if (detailRequestKeyRef.current === requestKey) {
      return;
    }
    detailRequestKeyRef.current = requestKey;
    void Promise.resolve(props.onLoadDetail());
  }, [
    missingImageCount,
    nearViewport,
    props.content,
    props.entryKey,
    props.onLoadDetail,
  ]);

  const handleCopy = async () => {
    if ((await copyTextToClipboard(visibleContent.text)) === "copied") {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div
      ref={messageRef}
      className="flex items-start justify-end gap-3"
      data-testid="chat-user-message"
      data-feed-key={props.entryKey}
    >
      <div className="chat-user-message-content min-w-0 max-w-[85%] sm:max-w-[75%]">
        <div className="rounded-2xl rounded-tr-md border border-[var(--user-bubble-border)] bg-[var(--user-bubble-bg)] px-3 py-2 text-[var(--user-bubble-fg)]">
          {props.attachments?.length || imageCount > attachmentImageCount ? (
            <UserMessageAttachments
              attachments={props.attachments ?? []}
              missingImageCount={missingImageCount}
              onOpenLocalFile={props.onOpenLocalFile}
            />
          ) : null}
          {visibleContent.text ? (
            <CollapsibleUserMessageText text={visibleContent.text} />
          ) : null}
        </div>
        <div className="chat-user-message-actions mt-1.5 flex min-h-7 items-center justify-end gap-1">
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] transition-colors"
            aria-label="Copy"
            title="Copy"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}

function UserMessageAttachments(props: {
  attachments: SessionInputAttachment[];
  missingImageCount: number;
  onOpenLocalFile?: ((path: string) => void) | undefined;
}) {
  const visibleMissingImages = Math.min(props.missingImageCount, 5);
  return (
    <div className="mb-2 flex max-w-full flex-wrap gap-2" aria-label="Message attachments">
      {props.attachments.map((attachment) => (
        <UserMessageAttachment
          key={attachment.id}
          attachment={attachment}
          onOpenLocalFile={props.onOpenLocalFile}
        />
      ))}
      {Array.from({ length: visibleMissingImages }, (_, index) => {
        const remaining =
          index === visibleMissingImages - 1
            ? props.missingImageCount > visibleMissingImages
              ? props.missingImageCount - visibleMissingImages + 1
              : 0
            : 0;
        return (
          <div
            key={`missing-image-${index}`}
            className="relative flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--user-bubble-border)] bg-[var(--app-bg)] text-[var(--app-hint)]"
            aria-label="Unavailable image attachment"
            title="Image preview unavailable"
          >
            <ImageIcon size={20} />
            {remaining > 0 ? (
              <span className="absolute inset-x-1 bottom-1 rounded bg-[var(--app-bg)] px-1 py-0.5 text-center text-[10px] font-medium">
                +{remaining}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function UserMessageAttachment(props: {
  attachment: SessionInputAttachment;
  onOpenLocalFile?: ((path: string) => void) | undefined;
}) {
  const [preview, setPreview] = useState<{ src?: string; path?: string; failed?: boolean }>({});
  const { ref: previewHostRef, nearViewport } = useNearViewport<HTMLButtonElement>();

  useEffect(() => {
    if (props.attachment.kind !== "image" || !nearViewport) {
      return;
    }
    let cancelled = false;
    void readAttachment(props.attachment.id)
      .then((response) => {
        if (cancelled) {
          return;
        }
        const src = response.file.contentBase64
          ? `data:${response.file.mimeType ?? props.attachment.mediaType};base64,${response.file.contentBase64}`
          : undefined;
        setPreview({
          ...(src ? { src } : {}),
          ...(response.file.path ? { path: response.file.path } : {}),
          ...(!src ? { failed: true } : {}),
        });
      })
      .catch(() => {
        if (!cancelled) {
          setPreview({ failed: true });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [nearViewport, props.attachment.id, props.attachment.kind, props.attachment.mediaType]);

  if (props.attachment.kind !== "image") {
    return (
      <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-2 text-xs text-[var(--app-muted)]">
        <File size={15} className="shrink-0" />
        <span className="truncate">{props.attachment.name}</span>
      </div>
    );
  }

  const canOpen = Boolean(preview.path && props.onOpenLocalFile);
  return (
    <button
      ref={previewHostRef}
      type="button"
      className="group relative h-20 w-20 shrink-0 overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-hint)]"
      onClick={() => {
        if (preview.path && props.onOpenLocalFile) {
          props.onOpenLocalFile(preview.path);
        }
      }}
      disabled={!canOpen}
      title={props.attachment.name}
      aria-label={`Open attached image ${props.attachment.name}`}
    >
      {preview.src ? (
        <img
          src={preview.src}
          alt={props.attachment.name}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center">
          <ImageIcon size={20} />
        </span>
      )}
      {preview.failed ? (
        <span className="absolute inset-x-1 bottom-1 truncate rounded bg-[var(--app-bg)] px-1 py-0.5 text-[10px]">
          Image
        </span>
      ) : null}
    </button>
  );
}
