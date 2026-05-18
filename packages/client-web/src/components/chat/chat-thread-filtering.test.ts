import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FeedEntry } from "../../types";
import { visibleFeedEntries } from "./chat-feed-filtering";

const TS = "2026-05-18T00:00:00.000Z";

function reasoningEntry(
  key: string,
  sourceProvider?: Extract<FeedEntry, { kind: "timeline" }>["sourceProvider"],
): FeedEntry {
  return {
    key,
    kind: "timeline",
    item: { kind: "reasoning", text: key },
    ts: TS,
    ...(sourceProvider ? { sourceProvider } : {}),
  };
}

function assistantEntry(key: string, sourceProvider?: Extract<FeedEntry, { kind: "timeline" }>["sourceProvider"]): FeedEntry {
  return {
    key,
    kind: "timeline",
    item: { kind: "assistant_message", text: key },
    ts: TS,
    ...(sourceProvider ? { sourceProvider } : {}),
  };
}

describe("chat thread filtering", () => {
  test("hides only OpenCode reasoning when the chat preference is enabled", () => {
    const entries = visibleFeedEntries(
      [
        reasoningEntry("opencode-reasoning", "opencode"),
        reasoningEntry("codex-reasoning", "codex"),
        assistantEntry("opencode-answer", "opencode"),
      ],
      false,
      true,
    );

    assert.deepEqual(entries.map((entry) => entry.key), [
      "codex-reasoning",
      "opencode-answer",
    ]);
  });

  test("uses the session provider as a fallback for older reasoning entries", () => {
    const entries = visibleFeedEntries(
      [reasoningEntry("legacy-reasoning"), assistantEntry("answer")],
      false,
      true,
      "opencode",
    );

    assert.deepEqual(entries.map((entry) => entry.key), ["answer"]);
  });

  test("keeps OpenCode reasoning when the chat preference is disabled", () => {
    const entries = visibleFeedEntries([reasoningEntry("opencode-reasoning", "opencode")], false);

    assert.deepEqual(entries.map((entry) => entry.key), ["opencode-reasoning"]);
  });
});
