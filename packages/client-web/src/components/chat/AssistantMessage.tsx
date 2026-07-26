import { MarkdownRenderer } from "./MarkdownRenderer";

export function AssistantMessage(props: {
  content: string;
  variant?: "final" | "process";
  onOpenLocalFile?: (path: string) => void;
}) {
  const isFinalReply = props.variant === "final";

  return (
    <div className="flex flex-col items-start" data-testid="chat-assistant-message">
      {isFinalReply ? (
        <MarkdownRenderer
          className="prose-chat prose-chat-final max-w-none text-[var(--app-fg)]"
          content={props.content}
          {...(props.onOpenLocalFile ? { onOpenLocalFile: props.onOpenLocalFile } : {})}
        />
      ) : (
        <div className="assistant-process-message">
          <MarkdownRenderer
            className="prose-chat prose-chat-process max-w-none text-[14px] leading-relaxed text-[var(--app-muted)]"
            content={props.content}
            {...(props.onOpenLocalFile ? { onOpenLocalFile: props.onOpenLocalFile } : {})}
          />
        </div>
      )}
    </div>
  );
}
