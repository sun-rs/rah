import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("conversation resource card contract", () => {
  test("keeps outputs in Inspector instead of duplicating them in the chat stream", () => {
    const chatThreadSource = readSource("./ChatThread.tsx");
    const conversationFeedSource = readSource("../../conversation-feed.ts");

    assert.doesNotMatch(chatThreadSource, /ConversationOutputsCard/);
    assert.doesNotMatch(conversationFeedSource, /kind: "turn_outputs"/);
  });

  test("keeps changed files visible with turn totals and a bounded reveal batch", () => {
    const fileChangesSource = readSource("./ConversationFileChangesCard.tsx");

    assert.match(fileChangesSource, /const INITIAL_VISIBLE_FILE_COUNT = 3/);
    assert.match(fileChangesSource, /const FILE_REVEAL_BATCH = 50/);
    assert.match(fileChangesSource, /Changed \{fileCount\}/);
    assert.match(fileChangesSource, /function ChangeCounts/);
    assert.equal(
      (
        fileChangesSource.match(
          /additions=\{props\.fileChanges\.totalAdditions\}/g,
        ) ?? []
      ).length,
      1,
    );
    assert.equal(
      (
        fileChangesSource.match(
          /deletions=\{props\.fileChanges\.totalDeletions\}/g,
        ) ?? []
      ).length,
      1,
    );
    assert.match(fileChangesSource, /inline-flex shrink-0 items-center gap-1\.5/);
    assert.doesNotMatch(fileChangesSource, /grid-cols/);
    assert.doesNotMatch(fileChangesSource, /w-\[7\.5rem\]/);
    assert.match(fileChangesSource, /tabular-nums/);
    assert.match(fileChangesSource, /CodexChangedFilesIcon/);
    assert.match(fileChangesSource, /aria-expanded=\{expanded\}/);
    assert.match(fileChangesSource, /Collapse files/);
    assert.match(fileChangesSource, /min-h-11/);
    assert.doesNotMatch(fileChangesSource, /min-h-14/);
    assert.match(fileChangesSource, /min-h-8/);
    assert.doesNotMatch(fileChangesSource, /divide-y/);
    assert.match(fileChangesSource, /border-b border-\[var\(--turn-resource-border\)\]/);
    assert.match(fileChangesSource, /border-\[var\(--turn-resource-border\)\]/);
    assert.equal(
      (
        fileChangesSource.match(
          /data-testid="conversation-turn-file-changes-footer"/g,
        ) ?? []
      ).length,
      2,
    );
    assert.ok(
      fileChangesSource.indexOf("Changed {fileCount}") <
        fileChangesSource.indexOf(
          "additions={props.fileChanges.totalAdditions}",
        ),
    );
    assert.ok(
      fileChangesSource.indexOf(
        "additions={props.fileChanges.totalAdditions}",
      ) < fileChangesSource.indexOf('aria-label="审查本轮变动"'),
    );
    assert.match(fileChangesSource, />\s*审查\s*</);
    assert.match(
      fileChangesSource,
      /border border-\[var\(--app-border\)\] bg-transparent/,
    );
    assert.match(
      fileChangesSource,
      /hover:bg-\[var\(--app-subtle-bg\)\]/,
    );
    assert.match(
      fileChangesSource,
      /active:bg-\[var\(--app-border\)\]/,
    );
    assert.doesNotMatch(fileChangesSource, /ScanSearch/);
    assert.doesNotMatch(fileChangesSource, /Review this turn/);
  });
});
