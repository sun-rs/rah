import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DebugEngine } from "./debug-engine";

describe("DebugEngine structured UI scenarios", () => {
  test("structured UI scenario replays every structural feed event family", () => {
    const engine = new DebugEngine();
    const script = engine.buildScenarioReplayScript("structured-ui-super-set");
    const types = new Set(script.events.map((event) => event.type));

    for (const type of [
      "timeline.item.added",
      "message.part.delta",
      "message.part.added",
      "tool.call.started",
      "tool.call.delta",
      "tool.call.completed",
      "observation.started",
      "observation.completed",
      "observation.failed",
      "permission.requested",
      "permission.resolved",
      "attention.required",
      "attention.cleared",
      "operation.started",
      "operation.resolved",
      "runtime.status",
      "notification.emitted",
      "usage.updated",
    ]) {
      assert.equal(types.has(type as never), true, type);
    }
  });
});
