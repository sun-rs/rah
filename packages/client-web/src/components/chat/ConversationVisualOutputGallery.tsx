import type { ConversationOutputProjection } from "@rah/runtime-protocol";
import { LocalImageResource } from "./LocalImageResource";

export function ConversationVisualOutputGallery(props: {
  outputs: readonly ConversationOutputProjection[];
  omittedCount: number;
  onOpenLocalFile?: (path: string) => void;
}) {
  return (
    <div
      className="conversation-visual-output-gallery flex flex-wrap items-start gap-3"
      data-testid="conversation-visual-output-gallery"
    >
      {props.outputs.map((output) => (
        <span
          key={output.id}
          className="conversation-visual-output-item inline-flex max-w-full"
          title={output.path ?? output.url ?? output.label}
          style={{ maxWidth: "min(12rem, calc(50% - 0.375rem))" }}
        >
          <LocalImageResource
            mode="inline"
            alt={output.label}
            {...(output.path ? { path: output.path } : {})}
            {...(output.url ? { url: output.url } : {})}
            {...(props.onOpenLocalFile
              ? { onOpenLocalFile: props.onOpenLocalFile }
              : {})}
          />
        </span>
      ))}
      {props.omittedCount > 0 ? (
        <span className="self-center text-xs text-[var(--app-hint)]">
          +{props.omittedCount} more
        </span>
      ) : null}
    </div>
  );
}
