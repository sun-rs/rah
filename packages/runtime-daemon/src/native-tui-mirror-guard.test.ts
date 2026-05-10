import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldIgnoreStaleMirrorPromptClean,
  shouldIgnoreStaleMirrorStateActivity,
} from "./native-tui-mirror-guard";

const injectedAt = Date.parse("2026-05-03T10:00:00.000Z");

describe("native TUI mirror guard", () => {
  test("ignores stale persisted state activity while a newer chat input is busy", () => {
    assert.equal(
      shouldIgnoreStaleMirrorStateActivity(
        { promptState: "agent_busy", lastInjectedInputAtMs: injectedAt },
        {
          provider: "claude",
          channel: "structured_persisted",
          authority: "authoritative",
          ts: "2026-05-03T09:59:59.000Z",
        },
        { type: "turn_completed", turnId: "old-turn" },
        "prompt_clean",
      ),
      true,
    );
  });

  test("ignores stale persisted prompt-clean transitions even for non-stateful activity", () => {
    assert.equal(
      shouldIgnoreStaleMirrorStateActivity(
        { promptState: "agent_busy", lastInjectedInputAtMs: injectedAt },
        {
          provider: "opencode",
          channel: "structured_persisted",
          authority: "authoritative",
          ts: "2026-05-03T09:59:59.000Z",
        },
        {
          type: "timeline_item",
          item: {
            kind: "assistant_message",
            text: "old answer",
          },
        },
        "prompt_clean",
      ),
      true,
    );
  });

  test("does not ignore newer persisted activity after the injected input", () => {
    assert.equal(
      shouldIgnoreStaleMirrorStateActivity(
        { promptState: "agent_busy", lastInjectedInputAtMs: injectedAt },
        {
          provider: "opencode",
          channel: "structured_persisted",
          authority: "authoritative",
          ts: "2026-05-03T10:00:01.000Z",
        },
        { type: "turn_completed", turnId: "new-turn" },
        "prompt_clean",
      ),
      false,
    );
  });

  test("does not ignore persisted activity with the same millisecond as injected input", () => {
    assert.equal(
      shouldIgnoreStaleMirrorStateActivity(
        { promptState: "agent_busy", lastInjectedInputAtMs: injectedAt },
        {
          provider: "claude",
          channel: "structured_persisted",
          authority: "authoritative",
          ts: "2026-05-03T10:00:00.000Z",
        },
        { type: "turn_completed", turnId: "same-ms-turn" },
        "prompt_clean",
      ),
      false,
    );
  });

  test("does not ignore structured live or heuristic activity", () => {
    assert.equal(
      shouldIgnoreStaleMirrorStateActivity(
        { promptState: "agent_busy", lastInjectedInputAtMs: injectedAt },
        {
          provider: "codex",
          channel: "structured_live",
          authority: "authoritative",
          ts: "2026-05-03T09:59:59.000Z",
        },
        { type: "turn_completed", turnId: "live-turn" },
        "prompt_clean",
      ),
      false,
    );
  });

  test("protects Claude assistant final-state prompt clean from stale mirror", () => {
    assert.equal(
      shouldIgnoreStaleMirrorPromptClean(
        { promptState: "agent_busy", lastInjectedInputAtMs: injectedAt },
        {
          provider: "claude",
          channel: "structured_persisted",
          authority: "authoritative",
          ts: "2026-05-03T09:59:59.000Z",
        },
      ),
      true,
    );
  });

  test("allows Claude assistant prompt clean at the same millisecond as injected input", () => {
    assert.equal(
      shouldIgnoreStaleMirrorPromptClean(
        { promptState: "agent_busy", lastInjectedInputAtMs: injectedAt },
        {
          provider: "claude",
          channel: "structured_persisted",
          authority: "authoritative",
          ts: "2026-05-03T10:00:00.000Z",
        },
      ),
      false,
    );
  });
});
