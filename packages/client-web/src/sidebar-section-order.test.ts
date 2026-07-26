import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  moveSidebarSectionItem,
  reconcileSidebarSectionOrder,
} from "./sidebar-section-order";

describe("sidebar section order", () => {
  test("keeps the saved order, removes stale entries, and appends newly available rows", () => {
    assert.deepEqual(
      reconcileSidebarSectionOrder(
        ["session:b", "missing", "session:a", "session:b"],
        ["session:a", "session:b", "session:c"],
      ),
      ["session:b", "session:a", "session:c"],
    );
  });

  test("moves a row before or after the row under the pointer", () => {
    assert.deepEqual(
      moveSidebarSectionItem(["a", "b", "c", "d"], "d", "b", "before"),
      ["a", "d", "b", "c"],
    );
    assert.deepEqual(
      moveSidebarSectionItem(["a", "b", "c", "d"], "a", "c", "after"),
      ["b", "c", "a", "d"],
    );
  });

  test("leaves the order stable for self-drops and unknown rows", () => {
    assert.deepEqual(
      moveSidebarSectionItem(["a", "b"], "a", "a", "after"),
      ["a", "b"],
    );
    assert.deepEqual(
      moveSidebarSectionItem(["a", "b"], "missing", "b", "before"),
      ["a", "b"],
    );
  });
});
