import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("conversation resource card contract", () => {
  test("renders outputs as a direct deliverable list without a redundant header", () => {
    const outputsSource = readSource("./ConversationOutputsCard.tsx");

    assert.match(outputsSource, /const COLLAPSED_OUTPUT_LIMIT = 3/);
    assert.doesNotMatch(outputsSource, /Outputs \(\$\{props\.outputs\.length\}\)/);
    assert.match(outputsSource, /outputTypeLabel\(output\)/);
    assert.match(outputsSource, /`Show \$\{overflowCount\} more`/);
    assert.match(outputsSource, /min-h-11/);
    assert.match(outputsSource, /h-8 w-8/);
    assert.doesNotMatch(outputsSource, />\s*Open\s*</);
  });

  test("keeps changed files visible with turn totals and a bounded reveal batch", () => {
    const fileChangesSource = readSource("./ConversationFileChangesCard.tsx");

    assert.match(fileChangesSource, /const INITIAL_VISIBLE_FILE_COUNT = 3/);
    assert.match(fileChangesSource, /const FILE_REVEAL_BATCH = 50/);
    assert.match(fileChangesSource, /Changed \{fileCount\}/);
    assert.match(fileChangesSource, /\+\{props\.fileChanges\.totalAdditions\}/);
    assert.match(fileChangesSource, /-\{props\.fileChanges\.totalDeletions\}/);
    assert.match(fileChangesSource, /FilePlus2/);
    assert.match(fileChangesSource, /aria-expanded=\{expanded\}/);
    assert.match(fileChangesSource, /Collapse files/);
    assert.match(fileChangesSource, /min-h-11/);
    assert.match(fileChangesSource, /min-h-9/);
  });
});
