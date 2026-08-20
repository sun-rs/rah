import type { ProviderKind } from "@rah/runtime-protocol";

export const CANVAS_SESSION_DRAG_TYPE = "application/x-rah-canvas-session";
const CANVAS_SESSION_TEXT_PREFIX = "rah-canvas-session:";

export type CanvasSessionDragTarget =
  | { kind: "runtime"; sessionId: string }
  | { kind: "stored"; provider: ProviderKind; providerSessionId: string };

type DragDataReader = Pick<DataTransfer, "getData">;
type DragDataWriter = Pick<DataTransfer, "setData">;

function isProviderKind(value: unknown): value is ProviderKind {
  return value === "codex" || value === "claude" || value === "opencode";
}

function parseCanvasSessionDragTarget(value: string): CanvasSessionDragTarget | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.kind === "runtime" && typeof parsed.sessionId === "string" && parsed.sessionId) {
      return { kind: "runtime", sessionId: parsed.sessionId };
    }
    if (
      parsed.kind === "stored" &&
      isProviderKind(parsed.provider) &&
      typeof parsed.providerSessionId === "string" &&
      parsed.providerSessionId
    ) {
      return {
        kind: "stored",
        provider: parsed.provider,
        providerSessionId: parsed.providerSessionId,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function writeCanvasSessionDragTarget(
  transfer: DragDataWriter,
  target: CanvasSessionDragTarget,
): void {
  const serialized = JSON.stringify(target);
  transfer.setData(CANVAS_SESSION_DRAG_TYPE, serialized);
  // Some WebKit drag bridges strip custom MIME values between sibling
  // surfaces. The namespaced text fallback keeps the payload local and
  // distinguishable from ordinary dragged text.
  transfer.setData("text/plain", `${CANVAS_SESSION_TEXT_PREFIX}${serialized}`);
}

export function readCanvasSessionDragTarget(
  transfer: DragDataReader,
): CanvasSessionDragTarget | null {
  const custom = parseCanvasSessionDragTarget(transfer.getData(CANVAS_SESSION_DRAG_TYPE));
  if (custom) {
    return custom;
  }
  const text = transfer.getData("text/plain");
  return text.startsWith(CANVAS_SESSION_TEXT_PREFIX)
    ? parseCanvasSessionDragTarget(text.slice(CANVAS_SESSION_TEXT_PREFIX.length))
    : null;
}
