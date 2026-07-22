import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildInspectorChangeTree, type InspectorChangeTreeFile } from "./InspectorChangeTree";

function file(id: string, path: string): InspectorChangeTreeFile {
  return { id, path, onOpen: () => undefined };
}

describe("InspectorChangeTree", () => {
  test("groups changed files into stable sorted directory nodes", () => {
    const tree = buildInspectorChangeTree(
      [
        file("b", "packages/client-web/src/z.ts"),
        file("a", "docs/readme.md"),
        file("c", "packages/client-web/src/a.tsx"),
        file("root", "package.json"),
      ],
      "/Users/example/rah",
    );

    assert.deepEqual(tree.directories.map((directory) => directory.name), ["docs", "packages"]);
    assert.equal(tree.files[0]?.displayName, "package.json");
    const packages = tree.directories[1]!;
    assert.equal(packages.directories[0]?.name, "client-web");
    const src = packages.directories[0]?.directories[0];
    assert.deepEqual(src?.files.map((entry) => entry.displayName), ["a.tsx", "z.ts"]);
  });

  test("removes the workspace prefix from absolute changed paths", () => {
    const tree = buildInspectorChangeTree(
      [file("one", "/Users/example/rah/src/main.rs")],
      "/Users/example/rah",
    );

    assert.equal(tree.directories[0]?.name, "src");
    assert.equal(tree.directories[0]?.files[0]?.displayName, "main.rs");
  });
});
