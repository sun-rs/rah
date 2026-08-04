import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  advanceSidebarDestructiveAction,
  SIDEBAR_DESTRUCTIVE_ACTION_ARM_TIMEOUT_MS,
} from "./sidebar-destructive-action";

describe("sidebar destructive action", () => {
  test("arms without executing on the first activation", () => {
    assert.deepEqual(advanceSidebarDestructiveAction(false), {
      armed: true,
      execute: false,
    });
  });

  test("executes and disarms on the second activation", () => {
    assert.deepEqual(advanceSidebarDestructiveAction(true), {
      armed: false,
      execute: true,
    });
  });

  test("uses the same short reset window as workspace removal", () => {
    assert.equal(SIDEBAR_DESTRUCTIVE_ACTION_ARM_TIMEOUT_MS, 2_000);
  });
});
