import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveLocalFileLinkPath } from "./components/chat/local-file-link";

describe("local file links", () => {
  test("resolves encoded same-origin local paths", () => {
    assert.equal(
      resolveLocalFileLinkPath(
        "/Users/sun/Library/Mobile%20Documents/com~apple~CloudDocs/Lab/playground/don't%20miss/notebooks/dont_miss_drawdown2_human_review_20260526_executed.ipynb",
      ),
      "/Users/sun/Library/Mobile Documents/com~apple~CloudDocs/Lab/playground/don't miss/notebooks/dont_miss_drawdown2_human_review_20260526_executed.ipynb",
    );
  });

  test("resolves localhost URLs that point at local paths", () => {
    assert.equal(
      resolveLocalFileLinkPath("http://127.0.0.1:43111/Users/sun/Code/repos/rah/README.md"),
      "/Users/sun/Code/repos/rah/README.md",
    );
  });

  test("resolves file URLs", () => {
    assert.equal(
      resolveLocalFileLinkPath("file:///Users/sun/Code/repos/rah/README.md"),
      "/Users/sun/Code/repos/rah/README.md",
    );
  });

  test("does not intercept normal web or app links", () => {
    assert.equal(resolveLocalFileLinkPath("https://example.com/Users/sun/file.txt"), null);
    assert.equal(resolveLocalFileLinkPath("/api/sessions"), null);
    assert.equal(resolveLocalFileLinkPath("notebooks/example.ipynb"), null);
  });
});
