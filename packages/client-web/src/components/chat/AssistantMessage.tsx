import type { TimelineAssistantContentPart } from "@rah/runtime-protocol";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { InteractiveVisualArtifact } from "./InteractiveVisualArtifact";

export function AssistantMessage(props: {
  content: string;
  contentParts?: TimelineAssistantContentPart[];
  sessionId?: string;
  entryKey?: string;
  variant?: "final" | "process";
  onOpenLocalFile?: (path: string) => void;
}) {
  const isFinalReply = props.variant === "final";
  const renderText = (content: string, key?: string) =>
    isFinalReply ? (
      <MarkdownRenderer
        key={key}
        className="prose-chat prose-chat-final max-w-none text-[var(--app-fg)]"
        content={content}
        {...(props.onOpenLocalFile
          ? { onOpenLocalFile: props.onOpenLocalFile }
          : {})}
      />
    ) : (
      <div key={key} className="assistant-process-message">
        <MarkdownRenderer
          className="prose-chat prose-chat-process max-w-none"
          content={content}
          {...(props.onOpenLocalFile
            ? { onOpenLocalFile: props.onOpenLocalFile }
            : {})}
        />
      </div>
    );

  return (
    <div
      className="flex w-full flex-col items-start gap-4"
      data-testid="chat-assistant-message"
      data-selection-source="conversation-message"
      data-selection-entry-key={props.entryKey}
      data-selection-role="assistant"
    >
      {props.contentParts
        ? props.contentParts.map((part, index) =>
            part.kind === "text" ? (
              renderText(part.text, `text:${index}`)
            ) : props.sessionId ? (
              <InteractiveVisualArtifact
                key={`visual:${part.artifact.id}:${index}`}
                sessionId={props.sessionId}
                artifact={part.artifact}
              />
            ) : null,
          )
        : renderText(props.content)}
    </div>
  );
}
