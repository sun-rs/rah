import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SIDEBAR_LAYOUT } from "./sidebar-layout-contract";

describe("sidebar layout contract", () => {
  test("locks fixed action slots and row heights", () => {
    assert.match(SIDEBAR_LAYOUT.workspaceActionSlotClassName, /\babsolute\b/);
    assert.match(SIDEBAR_LAYOUT.workspaceActionSlotClassName, /\bright-0\b/);
    assert.match(SIDEBAR_LAYOUT.sessionPinSlotClassName, /\bh-7\b/);
    assert.match(SIDEBAR_LAYOUT.sessionPinSlotClassName, /\bw-7\b/);
    assert.match(SIDEBAR_LAYOUT.workspaceHeaderClassName, /\brelative\b/);
    assert.match(SIDEBAR_LAYOUT.workspaceHeaderClassName, /min-h-\[32px\]/);
    assert.match(SIDEBAR_LAYOUT.sessionRowBaseClassName, /min-h-\[32px\]/);
    assert.match(SIDEBAR_LAYOUT.sessionRowBaseClassName, /\bborder\b/);
  });

  test("locks sidebar indentation and meta width tokens", () => {
    assert.equal(SIDEBAR_LAYOUT.sessionListClassName, "space-y-0.5 pt-0.5 pl-0.5 pr-0.5");
    assert.match(SIDEBAR_LAYOUT.sessionTimeClassName, /min-w-\[3\.5rem\]/);
    assert.match(SIDEBAR_LAYOUT.sessionStatusBadgeBaseClassName, /text-\[10px\]/);
  });

  test("uses matched workspace and session icon slots for aligned titles", () => {
    assert.match(SIDEBAR_LAYOUT.workspaceToggleButtonClassName, /\bh-7\b/);
    assert.match(SIDEBAR_LAYOUT.workspaceToggleButtonClassName, /\bw-7\b/);
    assert.equal(SIDEBAR_LAYOUT.sessionIconSlotClassName, "inline-flex h-7 w-7 shrink-0 items-center justify-center");
    assert.equal(SIDEBAR_LAYOUT.sessionIconClassName, "h-4.5 w-4.5");
    assert.equal(SIDEBAR_LAYOUT.sessionTitleClassName, "min-w-0 flex-1 truncate text-[12px]");
    assert.match(SIDEBAR_LAYOUT.workspaceTitleButtonClassName, /\bpr-6\b/);
    assert.match(SIDEBAR_LAYOUT.workspaceTitleSelectedClassName, /font-semibold/);
  });

  test("gives selected sessions a clearly visible selection treatment", () => {
    assert.match(SIDEBAR_LAYOUT.sessionRowSelectedClassName, /\bborder-emerald-500\/20\b/);
    assert.match(SIDEBAR_LAYOUT.sessionRowSelectedClassName, /inset_3px_0_0_0/);
  });

  test("keeps session status close to plain text instead of pill badges", () => {
    assert.doesNotMatch(SIDEBAR_LAYOUT.sessionStatusBadgeBaseClassName, /\bborder\b/);
    assert.doesNotMatch(SIDEBAR_LAYOUT.sessionStatusBadgeBaseClassName, /\brounded/);
    assert.doesNotMatch(SIDEBAR_LAYOUT.sessionStatusBadgeClassByStatus.ready, /\bbg-/);
  });

  test("keeps hidden hover actions non-interactive until revealed", () => {
    assert.match(SIDEBAR_LAYOUT.workspaceActionHiddenClassName, /pointer-events-none/);
    assert.match(SIDEBAR_LAYOUT.sessionPinHiddenClassName, /pointer-events-none/);
  });

  test("reveals hover-only actions for keyboard focus and coarse pointers", () => {
    assert.match(SIDEBAR_LAYOUT.workspaceActionHiddenClassName, /group-focus-within\/workspace:opacity-100/);
    assert.match(SIDEBAR_LAYOUT.workspaceActionHiddenClassName, /coarse-pointer-action-visible/);
    assert.match(SIDEBAR_LAYOUT.sessionPinHiddenClassName, /group-focus-within\/session:opacity-100/);
    assert.match(SIDEBAR_LAYOUT.sessionPinHiddenClassName, /coarse-pointer-action-visible/);
  });
});
