import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildInspectorChangeTree,
  collectExpandableInspectorChangeTreePaths,
  deriveInspectorChangeTreeVirtualWindow,
  flattenInspectorChangeTree,
  type InspectorChangeTreeFile,
} from "./InspectorChangeTree";

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
    assert.equal(packages.fileCount, 2);
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

  test("starts with directory summaries and expands only paths requested by the user", () => {
    const tree = buildInspectorChangeTree(
      [
        file("one", "packages/client-web/src/a.ts"),
        file("two", "packages/client-web/src/b.ts"),
        file("root", "package.json"),
      ],
      "/Users/example/rah",
    );

    const collapsed = flattenInspectorChangeTree(tree, new Set());
    assert.deepEqual(
      collapsed.map((row) => row.kind),
      ["directory", "file"],
    );
    const directory = collapsed[0];
    assert.equal(directory?.kind, "directory");
    assert.equal(
      directory?.kind === "directory" ? directory.label : null,
      "packages/client-web/src",
    );

    const expanded = flattenInspectorChangeTree(
      tree,
      new Set(["packages/client-web/src"]),
    );
    assert.deepEqual(
      expanded.map((row) => row.kind),
      ["directory", "file", "file", "file"],
    );
  });

  test("collects every compact directory path for an expand-all command", () => {
    const tree = buildInspectorChangeTree(
      [
        file("one", "packages/client-web/src/a.ts"),
        file("two", "packages/runtime-daemon/src/b.ts"),
        file("three", "docs/guide/start.md"),
      ],
      "/Users/example/rah",
    );

    const expandablePaths = collectExpandableInspectorChangeTreePaths(tree);
    assert.deepEqual(expandablePaths, [
      "docs/guide",
      "packages",
      "packages/client-web/src",
      "packages/runtime-daemon/src",
    ]);
    assert.equal(
      flattenInspectorChangeTree(tree, new Set(expandablePaths)).filter(
        (row) => row.kind === "file",
      ).length,
      3,
    );
  });

  test("search expansion reveals every matching file without mutating expansion state", () => {
    const tree = buildInspectorChangeTree(
      [file("one", "packages/client-web/src/a.ts")],
      "/Users/example/rah",
    );
    assert.deepEqual(
      flattenInspectorChangeTree(tree, new Set(), true).map(
        (row) => row.kind,
      ),
      ["directory", "file"],
    );
  });

  test("derives a bounded overscanned virtual row window", () => {
    assert.deepEqual(
      deriveInspectorChangeTreeVirtualWindow({
        rowCount: 1_000,
        visibleStartPx: 3_000,
        visibleEndPx: 3_600,
        rowHeightPx: 30,
        overscanRows: 5,
      }),
      { start: 95, end: 125 },
    );
  });
});
