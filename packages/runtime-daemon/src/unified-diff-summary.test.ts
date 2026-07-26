import assert from "node:assert/strict";
import test from "node:test";
import { summarizeUnifiedDiff } from "./unified-diff-summary";

test("summarizes multiple files from an aggregate turn diff", () => {
  const summary = summarizeUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const keep = true;
-const oldValue = 1;
+const newValue = 2;
+const extra = 3;
diff --git a/docs/readme.md b/docs/readme.md
new file mode 100644
--- /dev/null
+++ b/docs/readme.md
@@ -0,0 +1,2 @@
+# Demo
+Ready
`);

  assert.deepEqual(summary, {
    files: [
      { path: "docs/readme.md", additions: 2, deletions: 0 },
      { path: "src/a.ts", additions: 2, deletions: 1 },
    ],
    totalAdditions: 4,
    totalDeletions: 1,
  });
});

test("decodes quoted paths and prefers the renamed destination", () => {
  const summary = summarizeUnifiedDiff(`diff --git "a/docs/old name.md" "b/docs/new name.md"
similarity index 91%
rename from docs/old name.md
rename to docs/new name.md
--- "a/docs/old name.md"
+++ "b/docs/new name.md"
@@ -1 +1 @@
-old
+new
`);

  assert.deepEqual(summary.files, [
    { path: "docs/new name.md", additions: 1, deletions: 1 },
  ]);
});

test("keeps binary and deleted files in the snapshot", () => {
  const summary = summarizeUnifiedDiff(`diff --git a/assets/logo.png b/assets/logo.png
index 1111111..2222222 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
`);

  assert.deepEqual(summary, {
    files: [
      { path: "assets/logo.png", additions: 0, deletions: 0 },
      { path: "old.txt", additions: 0, deletions: 2 },
    ],
    totalAdditions: 0,
    totalDeletions: 2,
  });
});

test("decodes Git quoted UTF-8 octal paths as bytes", () => {
  const summary = summarizeUnifiedDiff(`diff --git "a/\\346\\265\\213\\350\\257\\225.txt" "b/\\346\\265\\213\\350\\257\\225.txt"
index 1111111..2222222 100644
--- "a/\\346\\265\\213\\350\\257\\225.txt"
+++ "b/\\346\\265\\213\\350\\257\\225.txt"
@@ -1 +1 @@
-old
+new
`);

  assert.deepEqual(summary.files, [
    { path: "测试.txt", additions: 1, deletions: 1 },
  ]);
});
