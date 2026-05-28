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
});
