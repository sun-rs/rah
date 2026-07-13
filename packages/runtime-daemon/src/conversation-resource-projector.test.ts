import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  ConversationItemProjection,
  ConversationItemStatus,
} from "@rah/runtime-protocol";
import { projectConversationTurnResources } from "./conversation-resource-projector";

function item(
  id: string,
  status: ConversationItemStatus,
  content: ConversationItemProjection["content"],
  options: { role?: ConversationItemProjection["role"]; ts?: string } = {},
): ConversationItemProjection {
  return {
    id,
    turnId: "turn-1",
    role: options.role ?? "process",
    status,
    startedAt: options.ts ?? "2026-07-12T00:00:00.000Z",
    completedAt: options.ts ?? "2026-07-12T00:00:00.000Z",
    content,
    source: {
      provider: "codex",
      channel: "structured_live",
      authority: "authoritative",
    },
    revision: 1,
  };
}

describe("conversation resource projector", () => {
  test("projects successful file writes as outputs and omits failed writes", () => {
    const successful = item("write-ok", "completed", {
      kind: "observation",
      observation: {
        id: "write-ok",
        kind: "file.write",
        status: "completed",
        title: "Write file",
        subject: { files: ["/workspace/report.md"] },
      },
    });
    const failed = item("write-failed", "failed", {
      kind: "observation",
      observation: {
        id: "write-failed",
        kind: "file.write",
        status: "failed",
        title: "Write file",
        subject: { files: ["/workspace/missing.md"] },
      },
    });

    const resources = projectConversationTurnResources([successful, failed]);
    assert.deepEqual(
      resources.outputs.map((output) => [output.path, output.activity, output.confidence]),
      [["/workspace/report.md", "written", "authoritative"]],
    );
  });

  test("deduplicates repeated reads and preserves source activities", () => {
    const read = item("read", "completed", {
      kind: "observation",
      observation: {
        id: "read",
        kind: "file.read",
        status: "completed",
        title: "Read file",
        subject: { files: ["/workspace/src/main.ts"] },
      },
    });
    const search = item(
      "search",
      "completed",
      {
        kind: "observation",
        observation: {
          id: "search",
          kind: "file.search",
          status: "completed",
          title: "Search files",
          subject: { files: ["/workspace/src/main.ts"] },
        },
      },
      { ts: "2026-07-12T00:00:01.000Z" },
    );

    const resources = projectConversationTurnResources([read, search]);
    assert.equal(resources.sources.length, 1);
    assert.deepEqual(resources.sources[0]?.activities, ["read", "searched"]);
    assert.deepEqual(resources.sources[0]?.sourceItemIds, ["read", "search"]);
    assert.equal(resources.sources[0]?.lastSeenAt, "2026-07-12T00:00:01.000Z");
  });

  test("projects attachments and web activity as sources", () => {
    const attachment = item("attachment", "completed", {
      kind: "timeline",
      item: {
        kind: "attachment",
        label: "diagram.png",
        path: "/workspace/diagram.png",
        mime: "image/png",
      },
    });
    const fetched = item("fetch", "completed", {
      kind: "observation",
      observation: {
        id: "fetch",
        kind: "web.fetch",
        status: "completed",
        title: "Fetch page",
        subject: { urls: ["https://example.com/docs#section"] },
      },
    });

    const resources = projectConversationTurnResources([attachment, fetched]);
    assert.deepEqual(
      resources.sources.map((source) => [source.kind, source.path ?? source.url, source.activities]),
      [
        ["image", "/workspace/diagram.png", ["provided"]],
        ["url", "https://example.com/docs", ["fetched"]],
      ],
    );
  });

  test("does not guess output ownership from final-answer links", () => {
    const final = item(
      "final",
      "completed",
      {
        kind: "timeline",
        item: {
          kind: "assistant_message",
          phase: "final_answer",
          text: "Created [report](/workspace/results/report.md) and [site](https://example.com).",
        },
      },
      { role: "final" },
    );

    const resources = projectConversationTurnResources([final]);
    assert.deepEqual(resources.outputs, []);
    assert.deepEqual(resources.sources, []);
  });
});
