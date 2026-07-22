import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSourceProjection } from "@rah/runtime-protocol";
import {
  groupInspectorSourceResources,
  inspectorResourceLabel,
} from "./InspectorResourcesPane";

function source(
  id: string,
  overrides: Partial<ConversationSourceProjection>,
): ConversationSourceProjection {
  return {
    id,
    kind: "url",
    label: "docs.pola.rs",
    confidence: "authoritative",
    sourceItemIds: [id],
    activities: ["searched"],
    ...overrides,
  };
}

test("keeps opened pages primary and folds search-only candidates into one group", () => {
  const attachment = source("attachment", {
    kind: "file",
    label: "notes.txt",
    path: "/tmp/notes.txt",
    url: undefined,
    activities: ["provided"],
  });
  const opened = source("opened", {
    url: "https://docs.pola.rs/user-guide/plugins/io_plugins/",
    activities: ["searched", "fetched"],
  });
  const candidate = source("candidate", {
    url: "https://docs.pola.rs/api/python/stable/reference/lazyframe/",
  });

  const groups = groupInspectorSourceResources([attachment, candidate, opened]);

  assert.deepEqual(groups.primary.map((resource) => resource.id), ["attachment", "opened"]);
  assert.deepEqual(groups.searchResults.map((resource) => resource.id), ["candidate"]);
});

test("uses a URL path label when provider history only supplies a repeated hostname", () => {
  assert.equal(
    inspectorResourceLabel(
      source("scan", {
        url: "https://docs.pola.rs/api/python/version/0.18/reference/api/polars.scan_parquet.html",
      }),
    ),
    "polars.scan_parquet",
  );
  assert.equal(
    inspectorResourceLabel(
      source("reference", {
        url: "https://docs.pola.rs/api/python/stable/reference/",
      }),
    ),
    "stable/reference",
  );
});
