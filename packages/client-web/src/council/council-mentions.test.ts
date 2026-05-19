import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCouncilMention,
  buildCouncilMentionOptions,
  filterCouncilMentionOptions,
  findCouncilMentionTrigger,
} from "./council-mentions";
import type { CouncilAgent } from "@rah/runtime-protocol";

const agents: CouncilAgent[] = [
  {
    id: "GPT-5.5-XHigh",
    provider: "codex",
    label: "GPT-5.5-XHigh",
    councilId: "council-1",
    status: "waiting",
    updatedAt: "2026-05-14T00:00:00.000Z",
    modelId: "gpt-5.5",
    reasoningId: "xhigh",
  },
  {
    id: "Default (recommended)-Max",
    provider: "claude",
    label: "Default (recommended)-Max",
    councilId: "council-1",
    status: "waiting",
    updatedAt: "2026-05-14T00:00:00.000Z",
    modelId: "opus",
    reasoningId: "max",
  },
];

test("findCouncilMentionTrigger detects an active @ token at the caret", () => {
  assert.deepEqual(findCouncilMentionTrigger("@gpt", 4), {
    start: 0,
    end: 4,
    query: "gpt",
  });
  assert.deepEqual(findCouncilMentionTrigger("ask @cla", 8), {
    start: 4,
    end: 8,
    query: "cla",
  });
  assert.equal(findCouncilMentionTrigger("email@test", 10), null);
  assert.equal(findCouncilMentionTrigger("@gpt done", 9), null);
});

test("filterCouncilMentionOptions searches special targets and agent metadata", () => {
  const options = buildCouncilMentionOptions(agents);
  assert.deepEqual(filterCouncilMentionOptions(options, "").map((option) => option.id), [
    "all",
    "GPT-5.5-XHigh",
    "Default (recommended)-Max",
  ]);
  assert.deepEqual(filterCouncilMentionOptions(options, "all").map((option) => option.id), [
    "all",
  ]);
  assert.deepEqual(filterCouncilMentionOptions(options, "gpt").map((option) => option.id), [
    "GPT-5.5-XHigh",
  ]);
  assert.deepEqual(filterCouncilMentionOptions(options, "recommended").map((option) => option.id), [
    "Default (recommended)-Max",
  ]);
});

test("applyCouncilMention replaces the current token and preserves surrounding text", () => {
  const trigger = findCouncilMentionTrigger("please @g", "please @g".length);
  assert.ok(trigger);
  const option = buildCouncilMentionOptions(agents)[1]!;
  assert.deepEqual(applyCouncilMention("please @g review", trigger, option), {
    nextValue: "please @GPT-5.5-XHigh review",
    caret: "please @GPT-5.5-XHigh ".length,
  });
});

test("findCouncilMentionTrigger keeps mentions conservative inside normal prose", () => {
  assert.deepEqual(findCouncilMentionTrigger("@all ask @g", "@all ask @g".length), {
    start: "@all ask ".length,
    end: "@all ask @g".length,
    query: "g",
  });
  assert.equal(findCouncilMentionTrigger("@all正文@g", "@all正文@g".length), null);
});
