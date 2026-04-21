import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventBus } from "./event-bus";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";
import {
  discoverKimiStoredSessions,
  getKimiStoredSessionHistoryPage,
  resumeKimiStoredSession,
} from "./kimi-session-files";

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

describe("Kimi session files", () => {
  let tmpShare: string;
  let previousShare: string | undefined;
  let workDir: string;

  beforeEach(() => {
    previousShare = process.env.KIMI_SHARE_DIR;
    tmpShare = mkdtempSync(path.join(os.tmpdir(), "rah-kimi-share-"));
    workDir = mkdtempSync(path.join(os.tmpdir(), "rah-kimi-workdir-"));
    process.env.KIMI_SHARE_DIR = tmpShare;
  });

  afterEach(() => {
    if (previousShare === undefined) {
      delete process.env.KIMI_SHARE_DIR;
    } else {
      process.env.KIMI_SHARE_DIR = previousShare;
    }
    rmSync(tmpShare, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  function writeKimiMetadata() {
    writeFileSync(
      path.join(tmpShare, "kimi.json"),
      JSON.stringify({
        work_dirs: [{ path: workDir, kaos: "local" }],
      }),
    );
  }

  function writeKimiSession(sessionId: string) {
    const sessionDir = path.join(tmpShare, "sessions", md5(workDir), sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, "wire.jsonl"),
      [
        JSON.stringify({ type: "metadata", protocol_version: "1.9" }),
        JSON.stringify({
          timestamp: 1_700_000_000,
          message: {
            type: "TurnBegin",
            payload: {
              user_input: [{ text: "Explain the architecture" }],
            },
          },
        }),
        JSON.stringify({
          timestamp: 1_700_000_001,
          message: {
            type: "StepBegin",
            payload: { n: 1 },
          },
        }),
        JSON.stringify({
          timestamp: 1_700_000_002,
          message: {
            type: "ThinkPart",
            payload: { think: "Inspecting files" },
          },
        }),
        JSON.stringify({
          timestamp: 1_700_000_003,
          message: {
            type: "TextPart",
            payload: { text: "I will inspect the repository." },
          },
        }),
        JSON.stringify({
          timestamp: 1_700_000_004,
          message: {
            type: "ToolCall",
            payload: {
              id: "tool-1",
              function: {
                name: "ReadFile",
                arguments: "{\"file_path\":\"README.md\"}",
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: 1_700_000_005,
          message: {
            type: "ToolResult",
            payload: {
              tool_call_id: "tool-1",
              return_value: {
                is_error: false,
                output: "README first line",
                message: "done",
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: 1_700_000_006,
          message: {
            type: "ApprovalRequest",
            payload: {
              id: "approval-1",
              tool_call_id: "tool-2",
              sender: "tool",
              action: "write_file",
              description: "write README.md",
              display: [],
            },
          },
        }),
        JSON.stringify({
          timestamp: 1_700_000_007,
          message: {
            type: "ApprovalResponse",
            payload: {
              request_id: "approval-1",
              response: "approve",
            },
          },
        }),
        JSON.stringify({
          timestamp: 1_700_000_008,
          message: {
            type: "PlanDisplay",
            payload: {
              content: "- inspect files\n- summarize findings",
              file_path: "plan.md",
            },
          },
        }),
        JSON.stringify({
          timestamp: 1_700_000_009,
          message: {
            type: "Notification",
            payload: {
              severity: "warning",
              title: "Kimi warning",
              body: "Something needs attention",
            },
          },
        }),
        JSON.stringify({
          timestamp: 1_700_000_010,
          message: {
            type: "StatusUpdate",
            payload: {
              token_usage: {
                input_other: 11,
                input_cache_read: 5,
                output: 7,
              },
              context_tokens: 123,
              max_context_tokens: 1000,
              context_usage: 0.1,
            },
          },
        }),
      ].join("\n") + "\n",
    );
  }

  test("discovers stored kimi sessions from metadata and wire file", () => {
    writeKimiMetadata();
    writeKimiSession("kimi-session-1");

    const stored = discoverKimiStoredSessions();
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.ref.provider, "kimi");
    assert.equal(stored[0]?.ref.providerSessionId, "kimi-session-1");
    assert.equal(stored[0]?.ref.cwd, workDir);
    assert.match(stored[0]?.ref.title ?? "", /Explain the architecture/);
  });

  test("replays kimi wire history into canonical events", () => {
    writeKimiMetadata();
    writeKimiSession("kimi-session-2");
    const stored = discoverKimiStoredSessions();
    const record = stored.find((item) => item.ref.providerSessionId === "kimi-session-2");
    assert.ok(record);

    const services = {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
    };

    const resumed = resumeKimiStoredSession({
      services,
      record: record!,
    });

    const page = getKimiStoredSessionHistoryPage({
      sessionId: resumed.sessionId,
      record: record!,
      limit: 100,
    });

    assert.ok(
      page.events.some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "user_message" &&
          event.payload.item.text === "Explain the architecture",
      ),
    );
    assert.ok(
      page.events.some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "assistant_message" &&
          event.payload.item.text === "I will inspect the repository.",
      ),
    );
    assert.ok(
      page.events.some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "reasoning" &&
          event.payload.item.text === "Inspecting files",
      ),
    );
    assert.ok(
      page.events.some(
        (event) =>
          event.type === "tool.call.completed" &&
          event.payload.toolCall.providerToolName === "ReadFile",
      ),
    );
    assert.ok(
      page.events.some(
        (event) =>
          event.type === "permission.requested" &&
          event.payload.request.title === "write_file",
      ),
    );
    assert.ok(
      page.events.some(
        (event) =>
          event.type === "permission.resolved" &&
          event.payload.resolution.requestId === "approval-1",
      ),
    );
    assert.ok(
      page.events.some(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "plan",
      ),
    );
    assert.ok(
      page.events.some(
        (event) =>
          event.type === "notification.emitted" &&
          event.payload.title === "Kimi warning" &&
          event.payload.body === "Something needs attention",
      ),
    );
    assert.ok(
      page.events.some(
        (event) =>
          event.type === "usage.updated" &&
          event.payload.usage.usedTokens === 123 &&
          event.payload.usage.contextWindow === 1000 &&
          event.payload.usage.percentRemaining === 90 &&
          event.payload.usage.inputTokens === 11 &&
          event.payload.usage.cachedInputTokens === 5 &&
          event.payload.usage.outputTokens === 7,
      ),
    );
  });
});
