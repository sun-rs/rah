import { MarkdownRenderer } from "./MarkdownRenderer";

export function Reasoning({
  text,
  onOpenLocalFile,
}: {
  text: string;
  onOpenLocalFile?: (path: string) => void;
}) {
  return (
    <div className="flex justify-start">
      <div
        className="max-w-[92%] text-sm leading-relaxed text-[var(--app-fg)]"
        data-testid="reasoning-summary"
      >
        <MarkdownRenderer
          className="prose-chat max-w-none"
          content={text}
          {...(onOpenLocalFile ? { onOpenLocalFile } : {})}
        />
      </div>
    </div>
  );
}
