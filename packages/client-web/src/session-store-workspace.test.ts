import assert from "node:assert/strict";
import test from "node:test";
import { appendVisibleWorkspaceDir } from "./session-store-workspace";

test("opening a session below an existing workspace does not create a nested workspace", () => {
  assert.deepEqual(
    appendVisibleWorkspaceDir(
      new Set(),
      ["/Users/sun/Code"],
      "/Users/sun/Code/repos/rah",
    ),
    ["/Users/sun/Code"],
  );
});

test("a session outside existing workspaces can still reveal its workspace", () => {
  assert.deepEqual(
    appendVisibleWorkspaceDir(
      new Set(),
      ["/Users/sun/Code"],
      "/Users/sun/Data/strategy",
    ),
    ["/Users/sun/Code", "/Users/sun/Data/strategy"],
  );
});
