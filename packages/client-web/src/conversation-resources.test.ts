import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationOutputProjection,
  ConversationSourceProjection,
  ConversationTurnProjection,
} from "@rah/runtime-protocol";
import {
  collectConversationResources,
  mergeConversationOutputs,
  mergeConversationSources,
  mergeConversationTurnResources,
} from "./conversation-resources";

const output = (overrides: Partial<ConversationOutputProjection> = {}): ConversationOutputProjection => ({
  id: "output-file",
  kind: "file",
  label: "report.md",
  path: "/workspace/report.md",
  activity: "written",
  confidence: "inferred",
  sourceItemIds: ["summary-item"],
  firstSeenAt: "2026-07-12T00:00:01.000Z",
  lastSeenAt: "2026-07-12T00:00:01.000Z",
  ...overrides,
});

const source = (overrides: Partial<ConversationSourceProjection> = {}): ConversationSourceProjection => ({
  id: "source-file",
  kind: "file",
  label: "input.md",
  path: "/workspace/input.md",
  activities: ["read"],
  confidence: "authoritative",
  sourceItemIds: ["read-item"],
  ...overrides,
});

test("resource merges preserve hydrated evidence across summary refreshes", () => {
  const mergedOutputs = mergeConversationOutputs(
    [output({ confidence: "authoritative", sourceItemIds: ["tool-item"] })],
    [output()],
  );
  assert.equal(mergedOutputs.length, 1);
  assert.equal(mergedOutputs[0]?.confidence, "authoritative");
  assert.deepEqual(mergedOutputs[0]?.sourceItemIds, ["tool-item", "summary-item"]);

  const mergedSources = mergeConversationSources(
    [source()],
    [source({ activities: ["searched"], sourceItemIds: ["search-item"] })],
  );
  assert.deepEqual(mergedSources[0]?.activities, ["read", "searched"]);
  assert.deepEqual(mergedSources[0]?.sourceItemIds, ["read-item", "search-item"]);
});

test("session resource aggregation deduplicates resources across turns", () => {
  const turn = (
    id: string,
    outputs: ConversationOutputProjection[],
    sources: ConversationSourceProjection[],
  ): ConversationTurnProjection => ({
    id,
    provider: "codex",
    status: "completed",
    statusAuthority: "native",
    items: [],
    outputs,
    sources,
    failedItemCount: 0,
    revision: 1,
  });
  const aggregated = collectConversationResources([
    turn("turn-1", [output()], [source()]),
    turn(
      "turn-2",
      [output({ activity: "updated", sourceItemIds: ["edit-item"] })],
      [source({ activities: ["searched"], sourceItemIds: ["search-item"] })],
    ),
  ]);
  assert.equal(aggregated.outputs.length, 1);
  assert.equal(aggregated.outputs[0]?.activity, "updated");
  assert.equal(aggregated.sources.length, 1);
  assert.deepEqual(aggregated.sources[0]?.activities, ["read", "searched"]);
});

test("turn resource merge preserves hydrated resources across resume summaries", () => {
  const fileChanges = {
    files: [{ path: "src/main.ts", additions: 12, deletions: 3 }],
    totalAdditions: 12,
    totalDeletions: 3,
  };
  const resources = mergeConversationTurnResources(
    {
      outputs: [output({ confidence: "authoritative" })],
      sources: [source()],
      fileChanges,
    },
    {},
  );

  assert.equal(resources.outputs?.length, 1);
  assert.equal(resources.sources?.length, 1);
  assert.deepEqual(resources.fileChanges, fileChanges);
});

test("turn resource merge accepts a newer authoritative file-change snapshot", () => {
  const resources = mergeConversationTurnResources(
    {
      fileChanges: {
        files: [{ path: "src/main.ts", additions: 1, deletions: 0 }],
        totalAdditions: 1,
        totalDeletions: 0,
      },
    },
    {
      fileChanges: {
        files: [{ path: "src/main.ts", additions: 4, deletions: 2 }],
        totalAdditions: 4,
        totalDeletions: 2,
      },
    },
  );

  assert.equal(resources.fileChanges?.totalAdditions, 4);
  assert.equal(resources.fileChanges?.totalDeletions, 2);
});
