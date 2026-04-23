import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { insertTextAtSelection } from "./composer-text-insertion";

describe("composer text insertion", () => {
  test("inserts plain reference into empty draft", () => {
    assert.deepEqual(
      insertTextAtSelection({
        current: "",
        selectionStart: 0,
        selectionEnd: 0,
        insertedText: "@./src ",
      }),
      {
        nextValue: "@./src ",
        caret: 7,
      },
    );
  });

  test("adds surrounding spaces only when needed", () => {
    assert.deepEqual(
      insertTextAtSelection({
        current: "please readREADME",
        selectionStart: 11,
        selectionEnd: 11,
        insertedText: "@./src ",
      }),
      {
        nextValue: "please read @./src README",
        caret: 19,
      },
    );
  });

  test("replaces selected text and preserves suffix spacing", () => {
    assert.deepEqual(
      insertTextAtSelection({
        current: "open PLACEHOLDER now",
        selectionStart: 5,
        selectionEnd: 16,
        insertedText: "@./docs ",
      }),
      {
        nextValue: "open @./docs now",
        caret: 13,
      },
    );
  });
});
