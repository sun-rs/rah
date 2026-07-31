import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexNativeTuiProviderHandler } from "./native-tui-codex-provider-handler";
import { NativeTuiHistoryCatalogIndex } from "./native-tui-history-catalog";

function line(
  timestamp: string,
  type: string,
  payload: Record<string, unknown>,
): string {
  return JSON.stringify({ timestamp, type, payload });
}

test("a targeted rollout lookup mirrors the final answer and terminal lifecycle immediately", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "rah-codex-live-mirror-"));
  const providerSessionId = "019fb2ea-dda5-73f1-a903-84197706395f";
  const rolloutPath = path.join(
    tempDir,
    `rollout-2026-07-30T20-06-04-${providerSessionId}.jsonl`,
  );
  const rows = [
    line("2026-07-30T12:06:18.017Z", "event_msg", {
      type: "task_started",
      turn_id: "turn-1",
    }),
    line("2026-07-30T12:06:18.018Z", "event_msg", {
      type: "user_message",
      message: "你是谁",
    }),
    line("2026-07-30T12:06:21.807Z", "event_msg", {
      type: "agent_message",
      message: "我是 Codex。",
      phase: "final_answer",
    }),
    line("2026-07-30T12:06:21.847Z", "event_msg", {
      type: "task_complete",
      turn_id: "turn-1",
      last_agent_message: "我是 Codex。",
    }),
  ];
  writeFileSync(rolloutPath, `${rows.join("\n")}\n`);

  let resolutions = 0;
  const catalog = new NativeTuiHistoryCatalogIndex({
    refresh: () => undefined,
    resolve: async () => {
      resolutions += 1;
      return {
        ref: {
          provider: "codex",
          providerSessionId,
          cwd: tempDir,
          rootDir: tempDir,
          title: "你是谁",
          source: "provider_history",
        },
        storagePath: rolloutPath,
        archived: false,
      };
    },
  });
  const handler = createCodexNativeTuiProviderHandler(catalog);

  try {
    const update = await handler.updateMirror(
      {
        sessionId: "rah-session",
        provider: "codex",
        providerSessionId,
        cwd: tempDir,
        startupTimestampMs: Date.parse("2026-07-30T12:06:04.000Z"),
      },
      undefined,
    );

    assert.equal(resolutions, 1);
    assert.equal(update.status, "ok");
    if (update.status !== "ok") {
      return;
    }
    assert.equal(
      update.items.some(
        ({ activity }) =>
          activity.type === "timeline_item" &&
          activity.item.kind === "assistant_message" &&
          activity.item.text === "我是 Codex。",
      ),
      true,
    );
    assert.equal(
      update.items.some(
        ({ activity }) =>
          activity.type === "turn_completed" &&
          activity.turnId === "turn-1",
      ),
      true,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
