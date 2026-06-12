import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readHostFileDataAsync } from "./workspace-utils";

describe("host file reads", () => {
  const pixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lz7c7wAAAABJRU5ErkJggg==",
    "base64",
  );

  test("reads absolute local files outside a workspace scope", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rah-host-file-"));
    try {
      const target = path.join(dir, "linked file.txt");
      await writeFile(target, "hello from outside workspace", "utf8");

      const file = await readHostFileDataAsync(target);

      assert.equal(file.path, target);
      assert.equal(file.binary, false);
      assert.equal(file.content, "hello from outside workspace");
      assert.equal(file.mimeType, undefined);
      assert.equal(file.sizeBytes, 28);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns inline preview metadata for small host images", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rah-host-file-image-"));
    try {
      const target = path.join(dir, "pixel.png");
      const png = pixelPng;
      await writeFile(target, png);

      const file = await readHostFileDataAsync(target);

      assert.equal(file.path, target);
      assert.equal(file.binary, true);
      assert.equal(file.content, "");
      assert.equal(file.mimeType, "image/png");
      assert.equal(file.sizeBytes, png.byteLength);
      assert.equal(file.contentBase64, png.toString("base64"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns a bounded inline preview for large host images", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rah-host-file-large-image-"));
    try {
      const target = path.join(dir, "large.png");
      const png = Buffer.concat([pixelPng, Buffer.alloc(1_100_000)]);
      await writeFile(target, png);

      const file = await readHostFileDataAsync(target, { imagePreviewMode: "bounded" });

      assert.equal(file.path, target);
      assert.equal(file.binary, true);
      assert.equal(file.content, "");
      assert.equal(file.truncated, true);
      assert.ok(file.mimeType?.startsWith("image/"));
      assert.ok(file.contentBase64);
      if (file.mimeType === "image/jpeg") {
        assert.ok(file.contentBase64.length < png.toString("base64").length);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns original inline data for large host images in full preview mode", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rah-host-file-full-image-"));
    try {
      const target = path.join(dir, "large.png");
      const png = Buffer.concat([pixelPng, Buffer.alloc(1_100_000)]);
      await writeFile(target, png);

      const file = await readHostFileDataAsync(target, { imagePreviewMode: "full" });

      assert.equal(file.binary, true);
      assert.equal(file.mimeType, "image/png");
      assert.equal(file.truncated, true);
      assert.equal(file.contentBase64, png.toString("base64"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("tags markdown files for rendered previews", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rah-host-file-markdown-"));
    try {
      const target = path.join(dir, "README.md");
      await writeFile(target, "# Title\n\nBody", "utf8");

      const file = await readHostFileDataAsync(target);

      assert.equal(file.binary, false);
      assert.equal(file.mimeType, "text/markdown");
      assert.equal(file.content, "# Title\n\nBody");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reads absolute local file references with line and column suffixes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rah-host-file-location-"));
    try {
      const target = path.join(dir, "README.md");
      await writeFile(target, "# Title\n\nBody", "utf8");

      const lineFile = await readHostFileDataAsync(`${target}:1`);
      const columnFile = await readHostFileDataAsync(`${target}:1:3`);

      assert.equal(lineFile.path, target);
      assert.equal(lineFile.content, "# Title\n\nBody");
      assert.equal(columnFile.path, target);
      assert.equal(columnFile.content, "# Title\n\nBody");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("prefers an exact host file path before stripping a line suffix", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rah-host-file-colon-"));
    try {
      const baseTarget = path.join(dir, "README.md");
      const exactTarget = `${baseTarget}:1`;
      await writeFile(baseTarget, "base", "utf8");
      await writeFile(exactTarget, "exact", "utf8");

      const file = await readHostFileDataAsync(exactTarget);

      assert.equal(file.path, exactTarget);
      assert.equal(file.content, "exact");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps medium notebooks intact for parsed previews", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rah-host-file-notebook-"));
    try {
      const target = path.join(dir, "analysis.ipynb");
      const notebook = JSON.stringify({
        cells: [
          {
            cell_type: "markdown",
            metadata: {},
            source: ["# Large notebook\n", "x".repeat(1_100_000)],
          },
        ],
        metadata: { language_info: { name: "python" } },
        nbformat: 4,
        nbformat_minor: 5,
      });
      await writeFile(target, notebook, "utf8");

      const file = await readHostFileDataAsync(target);

      assert.equal(file.binary, false);
      assert.equal(file.mimeType, "application/x-ipynb+json");
      assert.equal(file.truncated, undefined);
      assert.equal(file.content.length, notebook.length);
      assert.equal(file.notebookPreview?.language, "python");
      assert.equal(file.notebookPreview?.cells[0]?.source.startsWith("# Large notebook"), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns lightweight cell previews for notebooks bloated by image outputs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rah-host-file-large-notebook-"));
    try {
      const target = path.join(dir, "analysis.ipynb");
      const largeImageOutput = "a".repeat(8_100_000);
      const notebook = JSON.stringify({
        cells: [
          {
            cell_type: "markdown",
            metadata: {},
            source: ["# Review\n", "Only this text should matter."],
          },
          {
            cell_type: "code",
            execution_count: 7,
            metadata: {},
            source: ["print('ok')\n"],
            outputs: [
              {
                output_type: "display_data",
                data: {
                  "text/plain": ["<Figure size 640x480>"],
                  "image/png": largeImageOutput,
                },
              },
            ],
          },
        ],
        metadata: { language_info: { name: "python" } },
        nbformat: 4,
        nbformat_minor: 5,
      });
      await writeFile(target, notebook, "utf8");

      const file = await readHostFileDataAsync(target);

      assert.equal(file.binary, false);
      assert.equal(file.mimeType, "application/x-ipynb+json");
      assert.equal(file.truncated, true);
      assert.equal(file.notebookPreview?.cells.length, 2);
      assert.equal(file.notebookPreview?.language, "python");
      assert.equal(file.notebookPreview?.cells[0]?.source, "# Review\nOnly this text should matter.");
      assert.equal(file.notebookPreview?.cells[1]?.executionCount, 7);
      assert.equal(file.notebookPreview?.cells[1]?.outputSummary, "<Figure size 640x480>");
      assert.equal(file.content.includes(largeImageOutput.slice(0, 1000)), false);
      assert.equal(file.content.length < 10_000, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("continues truncating large non-notebook text files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rah-host-file-large-text-"));
    try {
      const target = path.join(dir, "large.json");
      await writeFile(target, "x".repeat(1_100_000), "utf8");

      const file = await readHostFileDataAsync(target);

      assert.equal(file.binary, false);
      assert.equal(file.mimeType, "application/json");
      assert.equal(file.truncated, true);
      assert.equal(file.content.length, 1_000_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("requires an absolute host file path", async () => {
    await assert.rejects(
      () => readHostFileDataAsync("relative-file.txt"),
      /absolute/,
    );
  });
});
