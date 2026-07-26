import assert from "node:assert/strict";
import test from "node:test";

import {
  collectManifestAssetFiles,
  retainedWebBuildGenerations,
  staleWebAssetFiles,
} from "./web-build-retention.mjs";

test("collects every asset owned by a Vite generation", () => {
  const manifest = {
    "index.html": {
      file: "assets/index-new.js",
      css: ["assets/index-new.css"],
      imports: ["_vendor.js"],
      dynamicImports: ["src/LazyPane.tsx"],
    },
    "_vendor.js": {
      file: "assets/vendor-new.js",
    },
    "src/LazyPane.tsx": {
      file: "assets/LazyPane-new.js",
      assets: ["assets/logo-new.svg"],
    },
  };
  assert.deepEqual(
    [...collectManifestAssetFiles(manifest)].sort(),
    [
      "LazyPane-new.js",
      "index-new.css",
      "index-new.js",
      "logo-new.svg",
      "vendor-new.js",
    ],
  );
});

test("retains at least three generations plus every generation inside the grace period", () => {
  const hour = 60 * 60 * 1_000;
  const now = 100 * hour;
  const generations = [
    { id: "old", createdAt: now - 72 * hour, assets: ["old.js"] },
    { id: "recent-4", createdAt: now - 20 * hour, assets: ["recent-4.js"] },
    { id: "recent-3", createdAt: now - 3 * hour, assets: ["recent-3.js"] },
    { id: "recent-2", createdAt: now - 2 * hour, assets: ["recent-2.js"] },
    { id: "recent-1", createdAt: now - hour, assets: ["recent-1.js"] },
  ];
  assert.deepEqual(
    retainedWebBuildGenerations(generations, {
      now,
      minimumGenerations: 3,
      gracePeriodMs: 24 * hour,
    }).map((generation) => generation.id),
    ["recent-4", "recent-3", "recent-2", "recent-1"],
  );
});

test("deletes only assets outside every retained generation", () => {
  assert.deepEqual(
    staleWebAssetFiles(
      ["current.js", "current.js.br", "previous.js", "abandoned.js"],
      [
        {
          id: "current",
          createdAt: 2,
          assets: ["current.js", "current.js.br"],
        },
        {
          id: "previous",
          createdAt: 1,
          assets: ["previous.js"],
        },
      ],
    ),
    ["abandoned.js"],
  );
});
