import assert from "node:assert/strict";
import { test } from "node:test";
import { allocateForkSessionTitle } from "./session-branch-title";

test("allocates desktop-style numbered fork titles", () => {
  assert.equal(allocateForkSessionTitle("Research", ["Research"]), "Research (2)");
  assert.equal(
    allocateForkSessionTitle("Research", ["Research", "Research (2)", "Research (4)"]),
    "Research (5)",
  );
});

test("continues a fork family when forking a numbered descendant", () => {
  assert.equal(
    allocateForkSessionTitle(
      "Research (2)",
      ["Research", "Research (2)", "Research (3)"],
      { parentIsFork: true },
    ),
    "Research (4)",
  );
});

test("does not mix unrelated titles or user-authored parenthetical text", () => {
  assert.equal(
    allocateForkSessionTitle("Research (draft)", ["Research (2)", "Research (draft)"]),
    "Research (draft) (2)",
  );
  assert.equal(allocateForkSessionTitle(undefined, []), "Codex (2)");
});

test("preserves user-authored numeric parenthetical suffixes on non-Fork parents", () => {
  assert.equal(
    allocateForkSessionTitle(
      "Research (2026)",
      ["Research (2026)", "Research (2026) (2)"],
    ),
    "Research (2026) (3)",
  );
});
