import type { RahEvent } from "@rah/runtime-protocol";
import { formatEventTimestamp } from "./shared";

export function InspectorEventsPane(props: { events: RahEvent[] }) {
  return (
    <div className="space-y-2">
      {props.events.length > 0 ? (
        props.events.map((event) => {
          const payload = event.payload as Record<string, unknown>;
          let detail: string | null = null;
          if (event.type === "timeline.item.added" || event.type === "timeline.item.updated") {
            const item = (payload.item ?? {}) as { kind?: string; text?: string };
            detail = item.text ?? item.kind ?? null;
          } else if (event.type.startsWith("observation.")) {
            const obs = (payload.observation ?? {}) as { kind?: string; title?: string };
            detail = obs.title ?? obs.kind ?? null;
          } else if (event.type.startsWith("tool.call.")) {
            const tool = (payload.toolCall ?? {}) as { providerToolName?: string };
            detail = tool.providerToolName ?? null;
          } else if (event.type.startsWith("permission.")) {
            const req = (payload.request ?? {}) as { kind?: string; title?: string };
            detail = req.title ?? req.kind ?? null;
          } else if (event.type === "session.state.changed") {
            detail = (payload.state as string | undefined) ?? null;
          } else if (event.type === "turn.input.appended") {
            detail = (payload.text as string | undefined) ?? null;
          } else if (event.type === "turn.failed" || event.type === "session.failed") {
            detail = (payload.error as string | undefined) ?? null;
          }
          return (
            <div
              key={event.seq}
              className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-semibold text-[var(--app-fg)]">{event.type}</div>
                <div className="text-xs text-[var(--app-hint)]">{formatEventTimestamp(event)}</div>
              </div>
              {detail ? (
                <div className="mt-1 line-clamp-3 text-xs text-[var(--app-hint)]">{detail}</div>
              ) : null}
            </div>
          );
        })
      ) : (
        <div className="text-sm text-[var(--app-hint)]">No events.</div>
      )}
    </div>
  );
}
