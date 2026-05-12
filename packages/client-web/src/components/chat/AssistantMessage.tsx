import { MarkdownRenderer } from "./MarkdownRenderer";

export function AssistantMessage(props: {
  content: string;
}) {
  return (
    <div className="flex flex-col items-start" data-testid="chat-assistant-message">
      <div className="max-w-full rounded-2xl rounded-tl-md border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-3 text-[var(--app-fg)]">
        <MarkdownRenderer
          className="prose-chat max-w-none text-[15px] leading-relaxed"
          content={props.content}
          fallbackClassName="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[15px] leading-relaxed"
        />
      </div>
    </div>
  );
}
