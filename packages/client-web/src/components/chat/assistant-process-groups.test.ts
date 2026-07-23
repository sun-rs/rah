import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, test } from "node:test";
import type { ToolFamily } from "@rah/runtime-protocol";
import type { FeedEntry } from "../../types";
import { AssistantProcessGroup } from "./AssistantProcessGroup";
import {
  buildProcessDetailRows,
  formatAssistantProcessDuration,
} from "./assistant-process-groups";
import { ProcessActivityEntry, processActivityLabel } from "./ProcessActivityEntry";
import { Reasoning } from "./Reasoning";

function assistant(
  key: string,
  ts: string,
  phase?: "commentary" | "final_answer",
): FeedEntry {
  return {
    key,
    kind: "timeline",
    item: { kind: "assistant_message", text: key, ...(phase ? { phase } : {}) },
    ts,
    turnId: "turn-1",
  };
}

function tool(
  key: string,
  family: ToolFamily,
  status: "running" | "completed" | "failed" = "completed",
): FeedEntry {
  return {
    key,
    kind: "tool_call",
    status,
    ts: "2026-07-10T00:00:02.000Z",
    turnId: "turn-1",
    toolCall: {
      id: key,
      family,
      providerToolName: family,
      title: key,
      result: { exitCode: status === "failed" ? 1 : 0 },
    },
  };
}

function command(key: string, status: "running" | "completed" | "failed" = "completed"): FeedEntry {
  return tool(key, "shell", status);
}

function reasoning(
  key: string,
  text = key,
  presentation?: "narrative" | "transient_status",
): FeedEntry {
  return {
    key,
    kind: "timeline",
    item: { kind: "reasoning", text, ...(presentation ? { presentation } : {}) },
    ts: "2026-07-10T00:00:02.000Z",
    turnId: "turn-1",
  };
}

describe("assistant process groups", () => {
  test("groups consecutive commands and treats a non-zero result as reviewable", () => {
    const rows = buildProcessDetailRows([
      command("command-1"),
      command("command-2", "failed"),
      assistant("commentary", "2026-07-10T00:00:03.000Z", "commentary"),
    ]);

    assert.equal(rows[0]?.kind, "activity_batch");
    if (rows[0]?.kind === "activity_batch") {
      assert.equal(rows[0].activityKind, "command");
      assert.equal(rows[0].summary.kind, "command");
      assert.equal(rows[0].summary.commandCount, 2);
      assert.equal(rows[0].entries.length, 2);
      assert.equal(rows[0].failureCount, 0);
      assert.equal(rows[0].issueCount, 1);
    }
    assert.equal(rows[1]?.kind, "entry");
  });

  test("folds consecutive mixed tool activity while preserving commentary boundaries", () => {
    const rows = buildProcessDetailRows([
      tool("read-1", "file_read"),
      command("command-1"),
      tool("read-2", "file_read"),
      tool("edit-1", "file_edit"),
      assistant("commentary", "2026-07-10T00:00:03.000Z", "commentary"),
      command("command-2"),
      tool("read-3", "file_read"),
    ]);

    assert.deepEqual(rows.map((row) => row.kind), [
      "activity_batch",
      "entry",
      "activity_batch",
    ]);
    if (rows[0]?.kind === "activity_batch") {
      assert.equal(rows[0].summary.kind, "file_change");
      assert.equal(rows[0].activityKind, "file_change");
      assert.deepEqual(rows[0].entries.map((entry) => entry.key), [
        "read-1",
        "command-1",
        "read-2",
        "edit-1",
      ]);
    }
    if (rows[2]?.kind === "activity_batch") {
      assert.equal(rows[2].summary.kind, "file_read_command");
      assert.deepEqual(rows[2].entries.map((entry) => entry.key), [
        "command-2",
        "read-3",
      ]);
    }
  });

  test("renders mixed tool activity as one collapsed inner batch by default", () => {
    const entries = [
      tool("read-1", "file_read"),
      command("command-1"),
      tool("edit-1", "file_edit"),
    ];
    const html = renderToStaticMarkup(
      createElement(AssistantProcessGroup, {
        group: {
          kind: "assistant_process_group",
          key: "process-1",
          entries,
          completed: false,
          active: true,
          startedAt: "2026-07-10T00:00:00.000Z",
          activities: [],
          turnStatus: "in_progress",
        },
        expanded: true,
        onExpandedChange: () => undefined,
        renderEntry: (entry) => createElement("span", null, `raw:${entry.key}`),
      }),
    );

    assert.match(html, /Edited files/);
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /process-activity-entry/);
    assert.doesNotMatch(html, /raw:read-1|raw:command-1|raw:edit-1/);
    assert.doesNotMatch(html, /rounded-lg border border-\[var\(--app-border\)\] bg-\[var\(--app-subtle-bg\)\]/);
    assert.doesNotMatch(html, /pl-5/);
  });

  test("keeps the Worked header stable when lazy detail reveals reviewable results", () => {
    const summaryHtml = renderToStaticMarkup(
      createElement(AssistantProcessGroup, {
        group: {
          kind: "assistant_process_group",
          key: "process-review",
          entries: [],
          completed: true,
          active: false,
          startedAt: "2026-07-10T00:00:00.000Z",
          completedAt: "2026-07-10T00:00:01.000Z",
          durationMs: 1_000,
          activities: [],
          turnStatus: "completed",
        },
        expanded: false,
        onExpandedChange: () => undefined,
        renderEntry: (entry) => createElement("span", null, `raw:${entry.key}`),
      }),
    );
    const hydratedExpandedHtml = renderToStaticMarkup(
      createElement(AssistantProcessGroup, {
        group: {
          kind: "assistant_process_group",
          key: "process-review",
          entries: [command("command-1", "failed")],
          completed: true,
          active: false,
          startedAt: "2026-07-10T00:00:00.000Z",
          completedAt: "2026-07-10T00:00:01.000Z",
          durationMs: 1_000,
          activities: [
            {
              kind: "command",
              totalCount: 1,
              runningCount: 0,
              interruptedCount: 0,
              failureCount: 0,
              issueCount: 1,
            },
          ],
          turnStatus: "completed",
        },
        expanded: true,
        onExpandedChange: () => undefined,
        renderEntry: (entry) => createElement("span", null, `raw:${entry.key}`),
      }),
    );
    const hydratedCollapsedHtml = renderToStaticMarkup(
      createElement(AssistantProcessGroup, {
        group: {
          kind: "assistant_process_group",
          key: "process-review",
          entries: [command("command-1", "failed")],
          completed: true,
          active: false,
          startedAt: "2026-07-10T00:00:00.000Z",
          completedAt: "2026-07-10T00:00:01.000Z",
          durationMs: 1_000,
          activities: [
            {
              kind: "command",
              totalCount: 1,
              runningCount: 0,
              interruptedCount: 0,
              failureCount: 0,
              issueCount: 1,
            },
          ],
          turnStatus: "completed",
        },
        expanded: false,
        onExpandedChange: () => undefined,
        renderEntry: (entry) => createElement("span", null, `raw:${entry.key}`),
      }),
    );

    for (const html of [summaryHtml, hydratedExpandedHtml, hydratedCollapsedHtml]) {
      assert.match(
        html,
        /<span class="min-w-0 truncate[^"]*">Worked 1s<\/span><svg[^>]*lucide-chevron-/,
      );
      assert.doesNotMatch(html, /Review results|lucide-triangle-alert/);
    }
    assert.match(summaryHtml, /lucide-chevron-right/);
    assert.match(hydratedExpandedHtml, /lucide-chevron-down/);
    assert.match(hydratedExpandedHtml, /Ran 1 command/);
    assert.match(hydratedExpandedHtml, /text-\[var\(--app-warning\)\]/);
    assert.match(hydratedCollapsedHtml, /lucide-chevron-right/);
  });

  test("groups consecutive reasoning summaries into one visible text row", () => {
    const rows = buildProcessDetailRows([
      reasoning("reasoning-1", "Inspecting"),
      reasoning("reasoning-2", "Planning"),
      reasoning("reasoning-3", "Inspecting"),
      assistant("commentary", "2026-07-10T00:00:03.000Z", "commentary"),
    ]);

    assert.equal(rows[0]?.kind, "reasoning_batch");
    if (rows[0]?.kind === "reasoning_batch") {
      assert.equal(rows[0].count, 3);
      assert.equal(rows[0].entry.kind, "timeline");
      if (rows[0].entry.kind === "timeline" && rows[0].entry.item.kind === "reasoning") {
        assert.equal(rows[0].entry.item.text, "Inspecting\n\nPlanning");
      }
    }
    assert.equal(rows[1]?.kind, "entry");
  });

  test("keeps reasoning visible and uses it as the boundary between activity groups", () => {
    const rows = buildProcessDetailRows([
      reasoning("reasoning-1", "Inspecting"),
      command("command-1"),
      command("command-2"),
      reasoning("reasoning-2", "Reviewing"),
      tool("read-1", "file_read"),
      tool("read-2", "file_read"),
    ]);

    assert.deepEqual(rows.map((row) => row.kind), [
      "reasoning_batch",
      "activity_batch",
      "reasoning_batch",
      "activity_batch",
    ]);
    assert.equal(
      rows.some(
        (row, index) =>
          row.kind === "activity_batch" && rows[index + 1]?.kind === "activity_batch",
      ),
      false,
    );

    const reasoningHtml = renderToStaticMarkup(
      createElement(Reasoning, { text: "**Inspecting**\n\nReviewing files" }),
    );
    assert.match(reasoningHtml, /data-testid="reasoning-summary"/);
    assert.match(reasoningHtml, /Inspecting/);
    assert.match(reasoningHtml, /Reviewing files/);
    assert.doesNotMatch(reasoningHtml, /aria-expanded|>Reasoning</);
  });

  test("keeps transient reasoning while active and removes it from settled Worked details", () => {
    const entries = [
      reasoning("transient", "Estimating lazy loading scope", "transient_status"),
      reasoning("narrative", "The stable boundary is the complete conversation pane."),
      assistant("commentary", "2026-07-10T00:00:03.000Z", "commentary"),
    ];
    const activeHtml = renderToStaticMarkup(
      createElement(AssistantProcessGroup, {
        group: {
          kind: "assistant_process_group",
          key: "process-active-reasoning",
          entries,
          completed: false,
          active: true,
          startedAt: "2026-07-10T00:00:00.000Z",
          activities: [],
          turnStatus: "in_progress",
        },
        expanded: true,
        onExpandedChange: () => undefined,
        renderEntry: (entry) =>
          createElement(
            "span",
            null,
            entry.kind === "timeline" && "text" in entry.item ? entry.item.text : entry.key,
          ),
      }),
    );
    const settledHtml = renderToStaticMarkup(
      createElement(AssistantProcessGroup, {
        group: {
          kind: "assistant_process_group",
          key: "process-settled-reasoning",
          entries,
          completed: true,
          active: false,
          startedAt: "2026-07-10T00:00:00.000Z",
          completedAt: "2026-07-10T00:00:04.000Z",
          activities: [],
          turnStatus: "completed",
        },
        expanded: true,
        onExpandedChange: () => undefined,
        renderEntry: (entry) =>
          createElement(
            "span",
            null,
            entry.kind === "timeline" && "text" in entry.item ? entry.item.text : entry.key,
          ),
      }),
    );

    assert.match(activeHtml, /Estimating lazy loading scope/);
    assert.doesNotMatch(settledHtml, /Estimating lazy loading scope/);
    assert.match(settledHtml, /The stable boundary is the complete conversation pane/);
    assert.match(
      settledHtml,
      /border-b border-\[var\(--app-border\)\] pb-3/,
    );
  });

  test("removes duplicate provider reasoning parts when a canonical reasoning row exists", () => {
    const reasoningPart: FeedEntry = {
      key: "reasoning-part",
      kind: "message_part",
      status: "updated",
      ts: "2026-07-10T00:00:02.000Z",
      turnId: "turn-1",
      part: {
        messageId: "reasoning-message",
        partId: "reasoning-part",
        kind: "reasoning",
        text: "Inspecting",
      },
    };
    const rows = buildProcessDetailRows([
      reasoningPart,
      reasoning("canonical-reasoning", "Inspecting"),
    ]);

    assert.deepEqual(rows.map((row) => row.kind), ["reasoning_batch"]);
  });

  test("does not classify provider reasoning parts as executable activity", () => {
    const reasoningPart: FeedEntry = {
      key: "reasoning-part",
      kind: "message_part",
      status: "updated",
      ts: "2026-07-10T00:00:02.000Z",
      turnId: "turn-1",
      part: {
        messageId: "reasoning-message",
        partId: "reasoning-part",
        kind: "reasoning",
        text: "Visible reasoning summary",
      },
    };
    const rows = buildProcessDetailRows([command("command-1"), reasoningPart, command("command-2")]);

    assert.deepEqual(rows.map((row) => row.kind), [
      "activity_batch",
      "entry",
      "activity_batch",
    ]);
  });

  test("formats compact elapsed time", () => {
    assert.equal(formatAssistantProcessDuration(72_655), "1m 12s");
    assert.equal(formatAssistantProcessDuration(9_900), "9s");
    assert.equal(formatAssistantProcessDuration(undefined), null);
  });

  test("describes code-mode wrapper tools instead of exposing the exec wrapper", () => {
    const wrappedTool = (value: string, status: "running" | "completed" = "completed"): FeedEntry => ({
      key: `exec-${status}`,
      kind: "tool_call",
      status,
      ts: "2026-07-10T00:00:02.000Z",
      turnId: "turn-1",
      toolCall: {
        id: `exec-${status}`,
        family: "other",
        providerToolName: "exec",
        title: "exec",
        input: { value },
      },
    });

    assert.equal(
      processActivityLabel(wrappedTool('const result = await tools.update_plan({plan: []});')),
      "Updated plan",
    );
    assert.equal(
      processActivityLabel(wrappedTool('const result = await tools.exec_command({cmd: "sed -n \\\"1,40p\\\" app.ts"});')),
      'Ran sed -n "1,40p" app.ts',
    );
    assert.equal(
      processActivityLabel(wrappedTool("await Promise.all([tools.exec_command({cmd: 'one'}), tools.exec_command({cmd: 'two'})]);")),
      "Ran 2 commands",
    );
    assert.equal(
      processActivityLabel(wrappedTool("await tools.mcp__node_repl__js({code: 'inspect'});", "running")),
      "Using browser",
    );
  });

  test("uses semantic fallbacks when structured tool details are absent", () => {
    const entry = tool("opaque-shell-title", "shell");
    assert.equal(processActivityLabel(entry), "Ran command");
  });

  test("keeps summarized native commands expandable for on-demand detail loading", () => {
    const entry: FeedEntry = {
      key: "native-command",
      kind: "observation",
      status: "completed",
      ts: "2026-07-10T00:00:02.000Z",
      turnId: "turn-1",
      observation: {
        id: "observation-1",
        kind: "command.run",
        status: "completed",
        title: "Run command",
        subject: { command: "pwd", cwd: "/workspace" },
        detailAvailable: true,
      },
    };
    const html = renderToStaticMarkup(
      createElement(ProcessActivityEntry, {
        entry,
        onLoadDetail: () => undefined,
      }),
    );

    assert.match(html, /Ran pwd/);
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, / disabled=""/);
  });

  test("renders normalized file targets as underlined local-file controls", () => {
    const entry: FeedEntry = {
      key: "read-file",
      kind: "observation",
      status: "completed",
      ts: "2026-07-10T00:00:02.000Z",
      turnId: "turn-1",
      observation: {
        id: "read-file",
        kind: "file.read",
        status: "completed",
        title: "Read file",
        subject: { files: ["src/store.ts"] },
      },
    };
    const html = renderToStaticMarkup(
      createElement(ProcessActivityEntry, {
        entry,
        onOpenLocalFile: () => undefined,
      }),
    );

    assert.match(html, /underline/);
    assert.match(html, /title="src\/store.ts"/);
    assert.doesNotMatch(html, /class="[^"]*w-full[^"]*focus-visible:ring/);
  });
});
