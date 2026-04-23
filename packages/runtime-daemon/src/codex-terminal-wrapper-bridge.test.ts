import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  applyLocalTerminalInput,
  extractCodexTerminalSessionId,
  hasCodexTerminalPrompt,
  nextPromptStateFromActivity,
  selectCodexStoredSessionCandidate,
  sliceUnprocessedRolloutLines,
} from "./codex-terminal-wrapper-bridge";

describe("codex terminal wrapper bridge helpers", () => {
  test("prefers the resumed provider session id when provided", () => {
    const record = selectCodexStoredSessionCandidate({
      records: [
        {
          ref: {
            provider: "codex",
            providerSessionId: "thread-1",
            cwd: "/repo",
            rootDir: "/repo",
            updatedAt: "2026-04-23T12:00:00.000Z",
          },
          rolloutPath: "/tmp/1.jsonl",
        },
        {
          ref: {
            provider: "codex",
            providerSessionId: "thread-2",
            cwd: "/repo",
            rootDir: "/repo",
            updatedAt: "2026-04-23T12:01:00.000Z",
          },
          rolloutPath: "/tmp/2.jsonl",
        },
      ],
      cwd: "/repo",
      startupTimestampMs: Date.parse("2026-04-23T12:01:10.000Z"),
      resumeProviderSessionId: "thread-1",
    });

    assert.equal(record?.ref.providerSessionId, "thread-1");
  });

  test("selects the freshest cwd-matching record near startup", () => {
    const record = selectCodexStoredSessionCandidate({
      records: [
        {
          ref: {
            provider: "codex",
            providerSessionId: "thread-old",
            cwd: "/repo",
            rootDir: "/repo",
            updatedAt: "2026-04-23T11:20:00.000Z",
          },
          rolloutPath: "/tmp/old.jsonl",
        },
        {
          ref: {
            provider: "codex",
            providerSessionId: "thread-new",
            cwd: "/repo",
            rootDir: "/repo",
            updatedAt: "2026-04-23T12:01:00.000Z",
          },
          rolloutPath: "/tmp/new.jsonl",
        },
      ],
      cwd: "/repo",
      startupTimestampMs: Date.parse("2026-04-23T12:01:30.000Z"),
    });

    assert.equal(record?.ref.providerSessionId, "thread-new");
  });

  test("prefers records updated after startup before falling back to nearby history", () => {
    const record = selectCodexStoredSessionCandidate({
      records: [
        {
          ref: {
            provider: "codex",
            providerSessionId: "thread-old",
            cwd: "/repo",
            rootDir: "/repo",
            updatedAt: "2026-04-23T12:01:00.000Z",
          },
          rolloutPath: "/tmp/old.jsonl",
        },
        {
          ref: {
            provider: "codex",
            providerSessionId: "thread-fresh",
            cwd: "/repo",
            rootDir: "/repo",
            updatedAt: "2026-04-23T12:03:00.000Z",
          },
          rolloutPath: "/tmp/fresh.jsonl",
        },
      ],
      cwd: "/repo",
      startupTimestampMs: Date.parse("2026-04-23T12:02:00.000Z"),
      updatedAfterMs: Date.parse("2026-04-23T12:02:00.000Z"),
    });

    assert.equal(record?.ref.providerSessionId, "thread-fresh");
  });

  test("returns null when no record has updated after startup and fallback is disabled", () => {
    const record = selectCodexStoredSessionCandidate({
      records: [
        {
          ref: {
            provider: "codex",
            providerSessionId: "thread-old",
            cwd: "/repo",
            rootDir: "/repo",
            updatedAt: "2026-04-23T12:01:00.000Z",
          },
          rolloutPath: "/tmp/old.jsonl",
        },
      ],
      cwd: "/repo",
      startupTimestampMs: Date.parse("2026-04-23T12:02:00.000Z"),
      updatedAfterMs: Date.parse("2026-04-23T12:02:00.000Z"),
    });

    assert.equal(record, null);
  });

  test("treats /private path aliases as the same cwd", () => {
    const record = selectCodexStoredSessionCandidate({
      records: [
        {
          ref: {
            provider: "codex",
            providerSessionId: "thread-private",
            cwd: "/private/tmp/project",
            rootDir: "/private/tmp/project",
            updatedAt: "2026-04-23T12:01:00.000Z",
          },
          rolloutPath: "/tmp/private.jsonl",
        },
      ],
      cwd: "/tmp/project",
      startupTimestampMs: Date.parse("2026-04-23T12:01:10.000Z"),
    });

    assert.equal(record?.ref.providerSessionId, "thread-private");
  });

  test("advances prompt state from provider activities", () => {
    assert.equal(
      nextPromptStateFromActivity("prompt_clean", {
        type: "turn_started",
        turnId: "turn-1",
      }),
      "agent_busy",
    );
    assert.equal(
      nextPromptStateFromActivity("agent_busy", {
        type: "turn_completed",
        turnId: "turn-1",
      }),
      "prompt_clean",
    );
  });

  test("slices unprocessed rollout lines by processed line count", () => {
    const first = sliceUnprocessedRolloutLines("a\nb\n", 0);
    assert.deepEqual(first, {
      lines: ["a", "b"],
      nextProcessedLineCount: 2,
    });

    const second = sliceUnprocessedRolloutLines("a\nb\nc\n", 2);
    assert.deepEqual(second, {
      lines: ["c"],
      nextProcessedLineCount: 3,
    });
  });

  test("tracks local terminal draft input and submission", () => {
    const tracker = { draftText: "" };

    assert.equal(
      applyLocalTerminalInput({
        tracker,
        promptState: "prompt_clean",
        data: "hello",
      }),
      "prompt_dirty",
    );
    assert.equal(tracker.draftText, "hello");

    assert.equal(
      applyLocalTerminalInput({
        tracker,
        promptState: "prompt_dirty",
        data: "\u007f",
      }),
      "prompt_dirty",
    );
    assert.equal(tracker.draftText, "hell");

    assert.equal(
      applyLocalTerminalInput({
        tracker,
        promptState: "prompt_dirty",
        data: "\r",
      }),
      "agent_busy",
    );
    assert.equal(tracker.draftText, "");
  });

  test("clears local terminal draft with control keys", () => {
    const tracker = { draftText: "" };

    applyLocalTerminalInput({
      tracker,
      promptState: "prompt_clean",
      data: "abc",
    });

    assert.equal(
      applyLocalTerminalInput({
        tracker,
        promptState: "prompt_dirty",
        data: "\u0015",
      }),
      "prompt_clean",
    );
    assert.equal(tracker.draftText, "");
  });

  test("ignores escape-sequence navigation input", () => {
    const tracker = { draftText: "" };

    assert.equal(
      applyLocalTerminalInput({
        tracker,
        promptState: "prompt_clean",
        data: "\u001b[A",
      }),
      "prompt_clean",
    );
    assert.equal(tracker.draftText, "");
  });

  test("extracts codex session id from tui status output with ansi escapes", () => {
    const sessionId = extractCodexTerminalSessionId(
      "\u001b[1mSession:\u001b[22m                     019dbaaf-6e7d-7be3-8f5c-f5c13993d6a9",
    );

    assert.equal(sessionId, "019dbaaf-6e7d-7be3-8f5c-f5c13993d6a9");
  });

  test("detects the codex prompt from terminal output with ansi escapes", () => {
    assert.equal(
      hasCodexTerminalPrompt("\u001b[32m›\u001b[39m "),
      true,
    );
    assert.equal(
      hasCodexTerminalPrompt("\n  \u001b[32m›\u001b[39m "),
      true,
    );
    assert.equal(
      hasCodexTerminalPrompt("no prompt here"),
      false,
    );
    assert.equal(
      hasCodexTerminalPrompt("› previous prompt\nWorking"),
      false,
    );
    assert.equal(
      hasCodexTerminalPrompt("› 描述一下李白这个人"),
      false,
    );
  });
});
