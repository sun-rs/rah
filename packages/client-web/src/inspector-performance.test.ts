import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DIFF_HIGHLIGHT_LIMITS,
  DIFF_PROGRESSIVE_RENDER,
  FILE_HIGHLIGHT_LIMITS,
  FILE_PROGRESSIVE_RENDER,
  getInitialVisibleCount,
  getNextVisibleCount,
  shouldHighlightPreview,
  shouldUseProgressiveRender,
} from "./inspector-performance";

describe("inspector performance helpers", () => {
  test("enables progressive diff rendering only above the threshold", () => {
    assert.equal(shouldUseProgressiveRender(DIFF_PROGRESSIVE_RENDER.threshold, DIFF_PROGRESSIVE_RENDER), false);
    assert.equal(shouldUseProgressiveRender(DIFF_PROGRESSIVE_RENDER.threshold + 1, DIFF_PROGRESSIVE_RENDER), true);
    assert.equal(getInitialVisibleCount(120, DIFF_PROGRESSIVE_RENDER), 120);
    assert.equal(getInitialVisibleCount(2_000, DIFF_PROGRESSIVE_RENDER), DIFF_PROGRESSIVE_RENDER.initial);
  });

  test("advances visible diff rows in bounded steps", () => {
    assert.equal(
      getNextVisibleCount(DIFF_PROGRESSIVE_RENDER.initial, 2_000, DIFF_PROGRESSIVE_RENDER),
      DIFF_PROGRESSIVE_RENDER.initial + DIFF_PROGRESSIVE_RENDER.step,
    );
    assert.equal(getNextVisibleCount(1_900, 2_000, DIFF_PROGRESSIVE_RENDER), 2_000);
  });

  test("enables progressive file rendering only above the threshold", () => {
    assert.equal(shouldUseProgressiveRender(FILE_PROGRESSIVE_RENDER.threshold, FILE_PROGRESSIVE_RENDER), false);
    assert.equal(shouldUseProgressiveRender(FILE_PROGRESSIVE_RENDER.threshold + 1, FILE_PROGRESSIVE_RENDER), true);
    assert.equal(getInitialVisibleCount(400, FILE_PROGRESSIVE_RENDER), 400);
    assert.equal(getInitialVisibleCount(4_000, FILE_PROGRESSIVE_RENDER), FILE_PROGRESSIVE_RENDER.initial);
  });

  test("only highlights previews within configured limits", () => {
    assert.equal(shouldHighlightPreview(null, 10, 100, DIFF_HIGHLIGHT_LIMITS), false);
    assert.equal(shouldHighlightPreview("rust", 100, 2_000, DIFF_HIGHLIGHT_LIMITS), true);
    assert.equal(
      shouldHighlightPreview("rust", DIFF_HIGHLIGHT_LIMITS.maxLines + 1, 2_000, DIFF_HIGHLIGHT_LIMITS),
      false,
    );
    assert.equal(
      shouldHighlightPreview("rust", 100, DIFF_HIGHLIGHT_LIMITS.maxChars + 1, DIFF_HIGHLIGHT_LIMITS),
      false,
    );
    assert.equal(shouldHighlightPreview("rust", 500, 20_000, FILE_HIGHLIGHT_LIMITS), true);
    assert.equal(
      shouldHighlightPreview("rust", 500, FILE_HIGHLIGHT_LIMITS.maxChars + 1, FILE_HIGHLIGHT_LIMITS),
      false,
    );
  });
});
