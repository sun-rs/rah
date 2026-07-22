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
  test("keeps ordinary file writes out of outputs unless a deliverable is surfaced", () => {
    const successful = item("write-ok", "completed", {
      kind: "observation",
      observation: {
        id: "write-ok",
        kind: "file.write",
        status: "completed",
        title: "Write file",
        subject: { files: ["/workspace/results/report.md"] },
      },
    });
    const failed = item("write-failed", "failed", {
      kind: "observation",
      observation: {
        id: "write-failed",
        kind: "file.write",
        status: "failed",
        title: "Write file",
        subject: { files: ["/workspace/src/missing.ts"] },
      },
    });

    assert.deepEqual(projectConversationTurnResources([successful, failed]).outputs, []);

    const final = item(
      "final",
      "completed",
      {
        kind: "timeline",
        item: {
          kind: "assistant_message",
          phase: "final_answer",
          text: "Created [report.md](/workspace/results/report.md) as the requested output.",
        },
      },
      { role: "final", ts: "2026-07-12T00:00:01.000Z" },
    );

    const resources = projectConversationTurnResources([successful, failed, final]);
    assert.deepEqual(
      resources.outputs.map((output) => [output.path, output.activity, output.confidence]),
      [["/workspace/results/report.md", "written", "authoritative"]],
    );
  });

  test("keeps generated media as outputs without requiring final-answer repetition", () => {
    const generated = item("image", "completed", {
      kind: "tool",
      toolCall: {
        id: "image",
        family: "media",
        providerToolName: "image_generation",
        title: "Generate image",
        detail: {
          artifacts: [
            {
              kind: "image",
              path: "/workspace/results/chart.png",
            },
          ],
        },
      },
    });

    assert.deepEqual(
      projectConversationTurnResources([generated]).outputs.map((output) => [
        output.path,
        output.activity,
      ]),
      [["/workspace/results/chart.png", "generated"]],
    );
  });

  test("does not infer linked source edits as outputs without a native artifact", () => {
    const edited = item("edit", "completed", {
      kind: "observation",
      observation: {
        id: "edit",
        kind: "file.edit",
        status: "completed",
        title: "Edit source",
        subject: { files: ["/workspace/src/main.ts"] },
      },
    });

    assert.deepEqual(projectConversationTurnResources([edited]).outputs, []);

    const final = item(
      "final",
      "completed",
      {
        kind: "timeline",
        item: {
          kind: "assistant_message",
          phase: "final_answer",
          text: "Updated [main.ts](/workspace/src/main.ts) as the requested deliverable.",
        },
      },
      { role: "final", ts: "2026-07-12T00:00:01.000Z" },
    );

    assert.deepEqual(projectConversationTurnResources([edited, final]).outputs, []);
  });

  test("allows explicitly delivered documents as outputs independently of changed files", () => {
    const edited = item("edit-report", "completed", {
      kind: "observation",
      observation: {
        id: "edit-report",
        kind: "file.edit",
        status: "completed",
        title: "Edit report",
        subject: { files: ["/workspace/results/report.md"] },
      },
    });
    const final = item(
      "final",
      "completed",
      {
        kind: "timeline",
        item: {
          kind: "assistant_message",
          phase: "final_answer",
          text: "Delivered [report.md](/workspace/results/report.md).",
        },
      },
      { role: "final", ts: "2026-07-12T00:00:01.000Z" },
    );

    assert.deepEqual(
      projectConversationTurnResources([edited, final]).outputs.map((output) => [
        output.path,
        output.activity,
        output.confidence,
      ]),
      [["/workspace/results/report.md", "updated", "authoritative"]],
    );
  });

  test("does not infer edited documents as outputs without explicit delivery", () => {
    const edited = item("edit-report", "completed", {
      kind: "observation",
      observation: {
        id: "edit-report",
        kind: "file.edit",
        status: "completed",
        title: "Edit report",
        subject: { files: ["/workspace/results/report.md"] },
      },
    });
    const final = item(
      "final",
      "completed",
      {
        kind: "timeline",
        item: {
          kind: "assistant_message",
          phase: "final_answer",
          text: "Updated the project documentation.",
        },
      },
      { role: "final", ts: "2026-07-12T00:00:01.000Z" },
    );

    assert.deepEqual(projectConversationTurnResources([edited, final]).outputs, []);
  });

  test("keeps explicitly delivered written documents in outputs", () => {
    const written = item("write", "completed", {
      kind: "observation",
      observation: {
        id: "write",
        kind: "file.write",
        status: "completed",
        title: "Write report",
        subject: { files: ["/workspace/results/report.md"] },
      },
    });
    const final = item(
      "final",
      "completed",
      {
        kind: "timeline",
        item: {
          kind: "assistant_message",
          phase: "final_answer",
          text: "Created [report.md](/workspace/results/report.md).",
        },
      },
      { role: "final", ts: "2026-07-12T00:00:01.000Z" },
    );

    assert.deepEqual(
      projectConversationTurnResources([written, final]).outputs.map((output) => [
        output.path,
        output.activity,
      ]),
      [["/workspace/results/report.md", "written"]],
    );
  });

  test("keeps generated artifacts in outputs without final-answer repetition", () => {
    const generated = item("image", "completed", {
      kind: "tool",
      toolCall: {
        id: "image",
        family: "media",
        providerToolName: "image_generation",
        title: "Generate image",
        detail: {
          artifacts: [{ kind: "image", path: "/workspace/results/chart.png" }],
        },
      },
    });

    assert.deepEqual(
      projectConversationTurnResources([generated]).outputs.map((output) => [
        output.path,
        output.activity,
      ]),
      [["/workspace/results/chart.png", "generated"]],
    );
  });

  test("projects provider-neutral wrapper file activity without relying on tool family", () => {
    const edited = item("wrapper-edit", "completed", {
      kind: "tool",
      toolCall: {
        id: "wrapper-edit",
        family: "other",
        providerToolName: "exec",
        activity: {
          kind: "file_change",
          action: "file_edit",
          files: [{ path: "/workspace/results/report.md", action: "edited" }],
        },
      },
    });
    const final = item(
      "final",
      "completed",
      {
        kind: "timeline",
        item: {
          kind: "assistant_message",
          phase: "final_answer",
          text: "Delivered [report.md](/workspace/results/report.md).",
        },
      },
      { role: "final", ts: "2026-07-12T00:00:01.000Z" },
    );

    assert.deepEqual(
      projectConversationTurnResources([edited, final]).outputs.map((output) => [
        output.path,
        output.activity,
      ]),
      [["/workspace/results/report.md", "updated"]],
    );
    assert.deepEqual(projectConversationTurnResources([edited]).outputs, []);
  });

  test("keeps local project reads and searches out of sources while preserving web fetches", () => {
    const read = item("wrapper-read", "completed", {
      kind: "tool",
      toolCall: {
        id: "wrapper-read",
        family: "other",
        providerToolName: "exec",
        activity: {
          kind: "file_read",
          action: "command",
          files: [
            { path: "/workspace/src/main.ts", action: "read" },
            { path: "320", action: "read" },
            { path: "2>/dev/null", action: "read" },
          ],
        },
      },
    });
    const search = item("wrapper-search", "completed", {
      kind: "tool",
      toolCall: {
        id: "wrapper-search",
        family: "other",
        providerToolName: "exec",
        activity: {
          kind: "search",
          action: "file_search",
          files: [{ path: "/workspace/src/main.ts", action: "searched" }],
        },
      },
    });
    const fetched = item("wrapper-browser", "completed", {
      kind: "tool",
      toolCall: {
        id: "wrapper-browser",
        family: "other",
        providerToolName: "browser",
        activity: {
          kind: "web",
          action: "browser",
          urls: ["https://example.com/docs#section"],
        },
      },
    });

    assert.deepEqual(
      projectConversationTurnResources([read, search, fetched]).sources.map((source) => [
        source.path ?? source.url,
        source.activities,
      ]),
      [["https://example.com/docs", ["fetched"]]],
    );
  });

  test("does not turn canonical local file-read activity into a source", () => {
    const observation = item("provider-observation", "completed", {
      kind: "observation",
      observation: {
        id: "provider-observation",
        kind: "unknown",
        status: "completed",
        title: "Provider activity",
        activity: {
          kind: "file_read",
          action: "file_read",
          files: [{ path: "/workspace/docs/design.md", action: "read" }],
        },
      },
    });

    assert.deepEqual(projectConversationTurnResources([observation]).sources, []);
  });

  test("rejects historical shell tokens that were misclassified as source paths", () => {
    const observation = item("legacy-wrapper-read", "completed", {
      kind: "observation",
      observation: {
        id: "legacy-wrapper-read",
        kind: "file.read",
        status: "completed",
        title: "Read files",
        activity: {
          kind: "file_read",
          action: "command",
          files: [
            { path: "docs/design.md", action: "read" },
            { path: "SELECT", action: "read" },
            { path: "FROM", action: "read" },
            { path: "json_each(product.raw_data)", action: "read" },
            { path: "1,115p", action: "read" },
            { path: "sqlite3", action: "read" },
          ],
        },
      },
    });

    assert.deepEqual(projectConversationTurnResources([observation]).sources, []);
  });

  test("keeps both local search targets and local reads out of sources", () => {
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

    assert.deepEqual(projectConversationTurnResources([read, search]).sources, []);
  });

  test("projects attachments and web activity as sources", () => {
    const attachment = item(
      "attachment",
      "completed",
      {
        kind: "timeline",
        item: {
          kind: "attachment",
          label: "diagram.png",
          path: "/workspace/diagram.png",
          mime: "image/png",
        },
      },
      { role: "user" },
    );
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

  test("recovers Codex Desktop attachments from persisted file preambles", () => {
    const user = item(
      "user-with-files",
      "completed",
      {
        kind: "timeline",
        item: {
          kind: "user_message",
          imageCount: 1,
          text: [
            "# Files mentioned by the user:",
            "",
            "## screenshot.png: /var/folders/example/T/codex-clipboard.png",
            "",
            "## pasted discussion: /Users/sun/.codex/attachments/id/pasted-text.txt",
            "## My request for Codex:",
            "Please compare them.",
          ].join("\n"),
        },
      },
      { role: "user" },
    );

    const resources = projectConversationTurnResources([user]);
    assert.deepEqual(
      resources.sources.map((source) => [source.label, source.kind, source.path]),
      [
        [
          "pasted discussion",
          "file",
          "/Users/sun/.codex/attachments/id/pasted-text.txt",
        ],
        ["screenshot.png", "image", "/var/folders/example/T/codex-clipboard.png"],
      ],
    );
  });

  test("does not promote ordinary prompt paths into Sources", () => {
    const user = item(
      "ordinary-user-path",
      "completed",
      {
        kind: "timeline",
        item: {
          kind: "user_message",
          text: "Please inspect /Users/sun/Code/project/src/main.rs.",
        },
      },
      { role: "user" },
    );

    assert.deepEqual(projectConversationTurnResources([user]).sources, []);
  });

  test("projects assistant image attachments as generated outputs", () => {
    const attachment = item(
      "generated-attachment",
      "completed",
      {
        kind: "timeline",
        item: {
          kind: "attachment",
          label: "result.png",
          path: "/workspace/results/result.png",
          mime: "image/png",
        },
      },
      { role: "final" },
    );

    const resources = projectConversationTurnResources([attachment]);
    assert.deepEqual(resources.sources, []);
    assert.deepEqual(
      resources.outputs.map((output) => [
        output.kind,
        output.path,
        output.activity,
        output.confidence,
      ]),
      [["image", "/workspace/results/result.png", "generated", "authoritative"]],
    );
  });

  test("keeps provider-native source attachments as outputs regardless of extension", () => {
    const attachment = item(
      "generated-source-attachment",
      "completed",
      {
        kind: "timeline",
        item: {
          kind: "attachment",
          label: "main.rs",
          path: "/workspace/results/main.rs",
          mime: "text/x-rust",
        },
      },
      { role: "final" },
    );

    assert.deepEqual(
      projectConversationTurnResources([attachment]).outputs.map((output) => [
        output.path,
        output.activity,
        output.confidence,
      ]),
      [["/workspace/results/main.rs", "generated", "authoritative"]],
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

  test("projects local images explicitly embedded in the final answer as outputs", () => {
    const final = item(
      "final",
      "completed",
      {
        kind: "timeline",
        item: {
          kind: "assistant_message",
          phase: "final_answer",
          text: [
            "Charts:",
            "![primary](/workspace/results/chart.png)",
            "![comparison](</workspace/results/chart 2.webp>)",
            "[source](/workspace/src/chart.ts)",
            "![remote](https://example.com/chart.png)",
            "![inline](data:image/png;base64,AAAA)",
          ].join("\n"),
        },
      },
      { role: "final" },
    );

    const resources = projectConversationTurnResources([final]);
    assert.deepEqual(
      resources.outputs.map((output) => [
        output.kind,
        output.path,
        output.activity,
        output.confidence,
      ]),
      [
        ["image", "/workspace/results/chart 2.webp", "generated", "authoritative"],
        ["image", "/workspace/results/chart.png", "generated", "authoritative"],
      ],
    );
    assert.deepEqual(resources.sources, []);
  });
});
