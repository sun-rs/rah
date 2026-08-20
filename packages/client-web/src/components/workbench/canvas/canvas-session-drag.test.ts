import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CANVAS_SESSION_DRAG_TYPE,
  readCanvasSessionDragTarget,
  writeCanvasSessionDragTarget,
} from "./canvas-session-drag.ts";

function memoryTransfer() {
  const values = new Map<string, string>();
  return {
    getData: (type: string) => values.get(type) ?? "",
    setData: (type: string, value: string) => values.set(type, value),
    values,
  };
}

describe("Canvas session drag payload", () => {
  test("round-trips runtime and stopped provider sessions", () => {
    for (const target of [
      { kind: "runtime", sessionId: "runtime-1" } as const,
      { kind: "stored", provider: "codex", providerSessionId: "provider-1" } as const,
    ]) {
      const transfer = memoryTransfer();
      writeCanvasSessionDragTarget(transfer, target);
      assert.deepEqual(readCanvasSessionDragTarget(transfer), target);
    }
  });

  test("uses the namespaced text fallback when a browser strips custom MIME data", () => {
    const transfer = memoryTransfer();
    const target = {
      kind: "stored",
      provider: "opencode",
      providerSessionId: "session-2",
    } as const;
    writeCanvasSessionDragTarget(transfer, target);
    transfer.values.delete(CANVAS_SESSION_DRAG_TYPE);
    assert.deepEqual(readCanvasSessionDragTarget(transfer), target);
  });

  test("rejects ordinary text and malformed provider identities", () => {
    assert.equal(readCanvasSessionDragTarget({ getData: () => "ordinary text" }), null);
    assert.equal(
      readCanvasSessionDragTarget({
        getData: (type) =>
          type === CANVAS_SESSION_DRAG_TYPE
            ? JSON.stringify({ kind: "stored", provider: "unknown", providerSessionId: "id" })
            : "",
      }),
      null,
    );
  });
});
