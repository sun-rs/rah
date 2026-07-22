import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolCall, WorkbenchObservation } from "./events";
import {
  deriveConversationActivityForObservation,
  deriveConversationActivityForToolCall,
  summarizeConversationActivityBatch,
} from "./conversation-activity";

describe("provider-neutral conversation activity", () => {
  test("preserves read semantics while presenting a sed invocation as a command", () => {
    const observation: WorkbenchObservation = {
      id: "read-1",
      kind: "file.read",
      status: "completed",
      title: "Read source",
      subject: {
        command: "sed -n '1,80p' src/app.ts",
        cwd: "/workspace",
        files: ["src/app.ts"],
      },
    };

    assert.deepEqual(deriveConversationActivityForObservation(observation), {
      kind: "file_read",
      action: "command",
      command: "sed -n '1,80p' src/app.ts",
      cwd: "/workspace",
      files: [{ path: "src/app.ts", action: "read" }],
      label: "Read source",
    });
  });

  test("normalizes code-mode wrappers without leaking wrapper JSON to clients", () => {
    const toolCall: ToolCall = {
      id: "wrapped-commands",
      family: "other",
      providerToolName: "exec",
      input: {
        value:
          "await Promise.all([tools.exec_command({cmd: 'one'}), tools.exec_command({cmd: 'two'})]);",
      },
    };

    assert.deepEqual(deriveConversationActivityForToolCall(toolCall), {
      kind: "command",
      action: "command",
      operationCount: 2,
      label: "exec",
    });
  });

  test("recovers web search queries and result URLs from code-mode wrapper artifacts", () => {
    const toolCall: ToolCall = {
      id: "wrapped-web-search",
      family: "other",
      providerToolName: "exec",
      title: "exec",
      input: {
        value: [
          "const result = await tools.web__run({",
          "  search_query: [{q: 'first query'}, {q: 'second query'}],",
          "  response_length: 'long'",
          "});",
        ].join("\n"),
      },
      detail: {
        artifacts: [
          {
            kind: "text",
            label: "stdout",
            text: [
              "First result (https://example.com/one)",
              "Second result: https://example.com/two?from=search",
            ].join("\n"),
          },
        ],
      },
    };

    assert.deepEqual(deriveConversationActivityForToolCall(toolCall), {
      kind: "web",
      action: "web_search",
      operationCount: 2,
      urls: ["https://example.com/one", "https://example.com/two?from=search"],
      query: "first query, second query",
      label: "exec",
    });
  });

  test("classifies code-mode page opens as fetched sources", () => {
    const toolCall: ToolCall = {
      id: "wrapped-web-open",
      family: "other",
      providerToolName: "exec",
      input: {
        value:
          "const result = await tools.web__run({open: [{ref_id: 'https://example.com/docs'}]});",
      },
      detail: {
        artifacts: [
          {
            kind: "json",
            label: "result",
            value: { source: { url: "https://example.com/docs" } },
          },
        ],
      },
    };

    assert.deepEqual(deriveConversationActivityForToolCall(toolCall), {
      kind: "web",
      action: "web_fetch",
      operationCount: 1,
      urls: ["https://example.com/docs"],
      label: "exec",
    });
  });

  test("classifies provider-agnostic shell reads for compact group summaries", () => {
    const toolCall: ToolCall = {
      id: "wrapped-read",
      family: "other",
      providerToolName: "exec",
      input: {
        value:
          "await tools.exec_command({cmd: \"sed -n '1,80p' src/store.ts\", workdir: '/workspace'});",
      },
    };

    assert.deepEqual(deriveConversationActivityForToolCall(toolCall), {
      kind: "file_read",
      action: "command",
      command: "sed -n '1,80p' src/store.ts",
      cwd: "/workspace",
      files: [{ path: "src/store.ts", action: "read" }],
      label: "exec",
    });
  });

  test("does not treat later multiline shell commands or SQL as sed file targets", () => {
    const toolCall: ToolCall = {
      id: "wrapped-multiline-read",
      family: "other",
      providerToolName: "exec",
      input: {
        value: [
          "await tools.exec_command({",
          "  cmd: `sed -n '1,80p' src/store.ts\niconv -f UTF-8 src/data.csv\nsqlite3 db.sqlite 'SELECT key FROM rows WHERE id=1'`,",
          "  workdir: '/workspace'",
          "});",
        ].join("\n"),
      },
    };

    const activity = deriveConversationActivityForToolCall(toolCall);
    assert.equal(activity.kind, "file_read");
    assert.deepEqual(activity.files, [{ path: "src/store.ts", action: "read" }]);
  });

  test("distinguishes created files from edited files in patch evidence", () => {
    const toolCall: ToolCall = {
      id: "patch-1",
      family: "patch",
      providerToolName: "apply_patch",
      input: {
        patch: "*** Begin Patch\n*** Add File: src/new.ts\n+export {};\n*** End Patch",
      },
    };

    const activity = deriveConversationActivityForToolCall(toolCall);
    assert.equal(activity.kind, "file_change");
    assert.equal(activity.action, "file_create");
    assert.deepEqual(activity.files, [{ path: "src/new.ts", action: "created" }]);
  });

  test("summarizes mixed read and command evidence like the desktop activity header", () => {
    const summary = summarizeConversationActivityBatch([
      {
        kind: "search",
        action: "file_search",
        query: "SessionStore",
      },
      {
        kind: "file_read",
        action: "command",
        command: "sed -n '1,80p' src/app.ts",
        files: [{ path: "src/app.ts", action: "read" }],
      },
      {
        kind: "file_read",
        action: "file_read",
        files: [{ path: "src/store.ts", action: "read" }],
      },
    ]);

    assert.deepEqual(summary, {
      kind: "file_read_command",
      primaryKind: "file_read",
      totalCount: 3,
      commandCount: 1,
      readCount: 3,
      changeCount: 0,
      webCount: 0,
      fileCount: 2,
    });
  });
});
