import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SIDEBAR_LAYOUT } from "./sidebar-layout-contract";

describe("sidebar layout contract", () => {
  test("locks fixed action slots and row heights", () => {
    assert.match(SIDEBAR_LAYOUT.workspaceActionSlotClassName, /\bw-7\b/);
    assert.match(SIDEBAR_LAYOUT.sessionPinSlotClassName, /\bh-5\b/);
    assert.match(SIDEBAR_LAYOUT.sessionPinSlotClassName, /\bw-5\b/);
    assert.match(SIDEBAR_LAYOUT.workspaceHeaderClassName, /min-h-\[34px\]/);
    assert.match(SIDEBAR_LAYOUT.sessionRowBaseClassName, /min-h-\[60px\]/);
  });

  test("locks sidebar indentation and meta width tokens", () => {
    assert.equal(SIDEBAR_LAYOUT.sessionListClassName, "space-y-0.5 pl-4 pr-0.5");
    assert.match(SIDEBAR_LAYOUT.sessionTimeClassName, /min-w-\[3\.25rem\]/);
    assert.match(SIDEBAR_LAYOUT.sessionStatusBadgeBaseClassName, /text-\[10px\]/);
  });

  test("keeps hidden hover actions non-interactive until revealed", () => {
    assert.match(SIDEBAR_LAYOUT.workspaceActionHiddenClassName, /pointer-events-none/);
    assert.match(SIDEBAR_LAYOUT.sessionPinHiddenClassName, /pointer-events-none/);
  });
});
