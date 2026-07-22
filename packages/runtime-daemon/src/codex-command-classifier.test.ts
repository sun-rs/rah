import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { classifyCodexCommand } from "./codex-command-classifier";

describe("classifyCodexCommand", () => {
  test("uses sed target files instead of sed range scripts", () => {
    const classified = classifyCodexCommand(
      "sed -n '1,220p' crates/solars-catalog/src/source/equity.rs",
    );

    assert.equal(classified.kind, "file.read");
    assert.equal(classified.title, "Read crates/solars-catalog/src/source/equity.rs");
    assert.deepEqual(classified.files, ["crates/solars-catalog/src/source/equity.rs"]);
  });

  test("does not expose shell loop variables as read targets", () => {
    const classified = classifyCodexCommand(
      'for f in crates/*/Cargo.toml; do echo "$f"; sed -n "1,220p" "$f"; done',
    );

    assert.equal(classified.kind, "command.run");
    assert.equal(classified.title, "Run command");
  });

  test("stops sed target extraction at a command newline", () => {
    const classified = classifyCodexCommand(
      [
        "sed -n '1,115p' docs/design.md",
        "iconv -f UTF-8 data.csv",
        "sqlite3 data.db 'SELECT key FROM rows WHERE product_id=1'",
      ].join("\n"),
    );

    assert.equal(classified.kind, "file.read");
    assert.deepEqual(classified.files, ["docs/design.md"]);
  });
});
