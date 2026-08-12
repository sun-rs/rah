import type { RahEvent, SessionSummary } from "@rah/runtime-protocol";
import { shouldPreserveProviderBoundStartup } from "./session-startup-event-guards";

type CurrentRuntimeProjection = {
  currentRuntimeStatus?: Extract<
    RahEvent,
    { type: "runtime.status" }
  >["payload"]["status"];
};

function sessionSummaryIsActivelyRunning(summary: SessionSummary): boolean {
  return (
    summary.session.status === "running" &&
    ["starting", "working", "stopping"].includes(summary.session.phase)
  );
}

export function nextRuntimeStatusForEvent(
  current: CurrentRuntimeProjection,
  nextSummary: SessionSummary,
  event: RahEvent,
): Extract<RahEvent, { type: "runtime.status" }>["payload"]["status"] | undefined {
  if (event.type === "runtime.status") {
    if (
      event.payload.status === "finished" &&
      shouldPreserveProviderBoundStartup(nextSummary, event.ts)
    ) {
      return current.currentRuntimeStatus ?? "thinking";
    }
    return event.payload.status;
  }
  if (
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "turn.canceled"
  ) {
    return undefined;
  }
  if (!sessionSummaryIsActivelyRunning(nextSummary)) {
    return undefined;
  }
  return current.currentRuntimeStatus;
}
