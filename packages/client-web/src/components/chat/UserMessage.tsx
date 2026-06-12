import { Check, Copy, Image as ImageIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { DATA_IMAGE_URL_PATTERN } from "../../composer-image-attachments";

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

export function UserMessage(props: {
  content: string;
  imageCount?: number | undefined;
  entryKey?: string | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const visibleContent = useMemo(
    () => visibleUserMessageContent(props.content),
    [props.content],
  );
  const imageCount = Math.max(props.imageCount ?? 0, visibleContent.imageCount);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(visibleContent.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className="flex items-start justify-end gap-3"
      data-testid="chat-user-message"
      data-feed-key={props.entryKey}
    >
      <div className="min-w-0 max-w-[85%] sm:max-w-[75%]">
        <div className="rounded-2xl rounded-tr-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-3 text-[var(--app-fg)]">
          {imageCount > 0 ? (
            <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs font-medium text-[var(--app-hint)]">
              <ImageIcon size={13} />
              <span>{imageCount === 1 ? "Image x1" : `Images x${imageCount}`}</span>
            </div>
          ) : null}
          {visibleContent.text ? (
            <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[15px] leading-relaxed">
              {visibleContent.text}
            </div>
          ) : null}
        </div>
        <div className="mt-1.5 flex justify-end">
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
