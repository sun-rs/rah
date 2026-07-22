import type { SessionInputAttachment } from "@rah/runtime-protocol";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  File,
  Image as ImageIcon,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
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
      {overflowing ? (
        <div className="mt-2 text-sm text-[var(--app-muted)]">
          {!expanded ? <div aria-hidden="true" className="leading-none">...</div> : null}
          <button
            type="button"
            className="mt-1 inline-flex items-center gap-1 rounded-sm font-medium text-[var(--app-muted)] outline-none transition-colors hover:text-[var(--app-fg)] focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--app-subtle-bg)]"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            <span>{expanded ? "Show less" : "Show more"}</span>
            {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
        </div>
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
}) {
  const [copied, setCopied] = useState(false);
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

  const handleCopy = async () => {
    if ((await copyTextToClipboard(visibleContent.text)) === "copied") {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div
      className="flex items-start justify-end gap-3"
      data-testid="chat-user-message"
      data-feed-key={props.entryKey}
    >
      <div className="min-w-0 max-w-[85%] sm:max-w-[75%]">
        <div className="rounded-2xl rounded-tr-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-3 text-[var(--app-fg)]">
          {props.attachments?.length ? (
            <UserMessageAttachments
              attachments={props.attachments}
              onOpenLocalFile={props.onOpenLocalFile}
            />
          ) : imageCount > 0 ? (
            <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs font-medium text-[var(--app-hint)]">
              <ImageIcon size={13} />
              <span>{imageCount === 1 ? "Image x1" : `Images x${imageCount}`}</span>
            </div>
          ) : null}
          {visibleContent.text ? (
            <CollapsibleUserMessageText text={visibleContent.text} />
          ) : null}
        </div>
        <div className="mt-1.5 flex min-h-7 items-center justify-end gap-1">
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
  onOpenLocalFile?: ((path: string) => void) | undefined;
}) {
  return (
    <div className="mb-2 flex max-w-full flex-wrap gap-2" aria-label="Message attachments">
      {props.attachments.map((attachment) => (
        <UserMessageAttachment
          key={attachment.id}
          attachment={attachment}
          onOpenLocalFile={props.onOpenLocalFile}
        />
      ))}
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
