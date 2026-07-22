import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildDiffRows, buildSplitDiffRows, readDiffPreferences } from "./shared";

describe("split diff layout", () => {
  test("defaults to the unified layout", () => {
    assert.equal(readDiffPreferences().diffLayout, "unified");
  });

  test("aligns replacements and leaves an empty before cell for pure additions", () => {
    const rows = buildDiffRows(
      [
        "diff --git a/example.rs b/example.rs",
        "--- a/example.rs",
        "+++ b/example.rs",
        "@@ -10,3 +10,4 @@",
        " alpha",
        "-old_value",
        "+new_value",
        "+extra_value",
        " omega",
      ].join("\n"),
    );

    const split = buildSplitDiffRows(rows);

    assert.equal(split[0]?.kind, "hunk");
    assert.deepEqual(split[1], {
      key: `split:${rows[1]!.key}`,
      kind: "pair",
      before: {
        key: `${rows[1]!.key}:before`,
        kind: "context",
        lineNumber: 10,
        text: "alpha",
      },
      after: {
        key: `${rows[1]!.key}:after`,
        kind: "context",
        lineNumber: 10,
        text: "alpha",
      },
    });

    const replacement = split[2];
    assert.equal(replacement?.kind, "pair");
    if (replacement?.kind === "pair") {
      assert.equal(replacement.before?.lineNumber, 11);
      assert.equal(replacement.before?.text, "old_value");
      assert.equal(replacement.after?.lineNumber, 11);
      assert.equal(replacement.after?.text, "new_value");
    }

    const addition = split[3];
    assert.equal(addition?.kind, "pair");
    if (addition?.kind === "pair") {
      assert.equal(addition.before, null);
      assert.equal(addition.after?.lineNumber, 12);
      assert.equal(addition.after?.text, "extra_value");
    }
  });

  test("keeps independent old and new line numbers for context rows", () => {
    const rows = buildDiffRows(
      ["@@ -41,2 +51,2 @@", " unchanged", "-before", "+after"].join("\n"),
    );
    const context = rows[1];

    assert.equal(context?.kind, "context");
    assert.equal(context?.oldLineNumber, 41);
    assert.equal(context?.newLineNumber, 51);
  });
});
