import ReactMarkdown from "react-markdown";

export function AssistantMessage(props: { content: string }) {
  return (
    <div className="flex items-start justify-start gap-3">
      <div className="max-w-full rounded-2xl rounded-tl-md border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-3 text-[var(--app-fg)]">
        <div className="prose-chat max-w-none text-[15px] leading-relaxed">
          <ReactMarkdown>{props.content}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
