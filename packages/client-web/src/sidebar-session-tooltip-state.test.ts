import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  INITIAL_SIDEBAR_SESSION_TOOLTIP_STATE,
  reduceSidebarSessionTooltipState,
  type SidebarSessionTooltipState,
} from "./sidebar-session-tooltip-state";

function enter(
  state: SidebarSessionTooltipState,
  key: string,
  anchor: object,
): SidebarSessionTooltipState {
  return reduceSidebarSessionTooltipState(state, {
    type: "pointer-enter",
    key,
    anchor,
  });
}

describe("sidebar session tooltip state", () => {
  test("cancels a pending hover and rejects its stale timer", () => {
    const anchor = {};
    const pending = enter(INITIAL_SIDEBAR_SESSION_TOOLTIP_STATE, "a", anchor);
    assert.equal(pending.phase, "pending");
    const pendingEpoch = pending.epoch;

    const canceled = reduceSidebarSessionTooltipState(pending, { type: "cancel" });
    assert.equal(canceled.phase, "idle");
    assert.equal(
      reduceSidebarSessionTooltipState(canceled, {
        type: "delay-elapsed",
        epoch: pendingEpoch,
        eligible: true,
      }),
      canceled,
    );
  });

  test("opens only the latest hovered row", () => {
    const firstAnchor = {};
    const secondAnchor = {};
    const firstPending = enter(
      INITIAL_SIDEBAR_SESSION_TOOLTIP_STATE,
      "first",
      firstAnchor,
    );
    const secondPending = enter(firstPending, "second", secondAnchor);
    assert.equal(secondPending.phase, "pending");

    const afterStaleTimer = reduceSidebarSessionTooltipState(secondPending, {
      type: "delay-elapsed",
      epoch: firstPending.epoch,
      eligible: true,
    });
    assert.equal(afterStaleTimer, secondPending);

    const opened = reduceSidebarSessionTooltipState(afterStaleTimer, {
      type: "delay-elapsed",
      epoch: secondPending.epoch,
      eligible: true,
    });
    assert.deepEqual(opened, {
      phase: "open",
      epoch: secondPending.epoch,
      key: "second",
      anchor: secondAnchor,
      source: "pointer",
    });
  });

  test("drops a timer result when its anchor is no longer eligible", () => {
    const pending = enter(INITIAL_SIDEBAR_SESSION_TOOLTIP_STATE, "a", {});
    const result = reduceSidebarSessionTooltipState(pending, {
      type: "delay-elapsed",
      epoch: pending.epoch,
      eligible: false,
    });
    assert.equal(result.phase, "idle");
  });

  test("opens keyboard focus immediately and closes only for its own leave", () => {
    const anchor = {};
    const otherAnchor = {};
    const open = reduceSidebarSessionTooltipState(
      INITIAL_SIDEBAR_SESSION_TOOLTIP_STATE,
      { type: "keyboard-focus", key: "a", anchor },
    );
    assert.equal(open.phase, "open");
    assert.equal(open.phase === "open" ? open.source : null, "keyboard");

    const unrelatedLeave = reduceSidebarSessionTooltipState(open, {
      type: "pointer-leave",
      key: "b",
      anchor: otherAnchor,
    });
    assert.equal(unrelatedLeave, open);
    assert.equal(
      reduceSidebarSessionTooltipState(unrelatedLeave, {
        type: "pointer-leave",
        key: "a",
        anchor,
      }).phase,
      "idle",
    );
  });

  test("does not restart the delay while moving inside one row", () => {
    const anchor = {};
    const pending = enter(INITIAL_SIDEBAR_SESSION_TOOLTIP_STATE, "a", anchor);
    assert.equal(enter(pending, "a", anchor), pending);
  });
});
