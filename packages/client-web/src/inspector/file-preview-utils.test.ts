import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildImageDataUrl,
  parseDelimitedTable,
  parseNotebookPreview,
  resolveFilePreviewKind,
} from "./file-preview-utils";

describe("file preview utils", () => {
  test("detects image, table, notebook, markdown, and text previews", () => {
    assert.equal(resolveFilePreviewKind("/tmp/chart.png", undefined), "image");
    assert.equal(resolveFilePreviewKind("/tmp/data.csv", undefined), "table");
    assert.equal(resolveFilePreviewKind("/tmp/book.ipynb", undefined), "notebook");
    assert.equal(resolveFilePreviewKind("/tmp/readme.md", undefined), "markdown");
    assert.equal(resolveFilePreviewKind("/tmp/notes.markdown", undefined), "markdown");
    assert.equal(resolveFilePreviewKind("/tmp/readme.txt", "text/markdown"), "markdown");
    assert.equal(resolveFilePreviewKind("/tmp/readme.txt", undefined), "text");
  });

  test("builds image data urls from base64 metadata", () => {
    assert.equal(
      buildImageDataUrl({
        path: "/tmp/pixel.png",
        content: "",
        contentBase64: "abc123",
        mimeType: "image/png",
      }),
      "data:image/png;base64,abc123",
    );
  });

  test("parses quoted csv cells", () => {
    const table = parseDelimitedTable("/tmp/data.csv", "name,value\n\"a,b\",2\nc,\"d\"\"e\"\n");

    assert.deepEqual(table.rows, [
      ["name", "value"],
      ["a,b", "2"],
      ["c", "d\"e"],
    ]);
    assert.equal(table.delimiter, ",");
  });

  test("summarizes notebook cells and outputs", () => {
    const notebook = parseNotebookPreview(JSON.stringify({
      cells: [
        { cell_type: "markdown", source: ["# Title\n"] },
        {
          cell_type: "code",
          execution_count: 3,
          source: ["print('ok')\n"],
          outputs: [{ output_type: "stream", text: ["ok\n"] }],
        },
      ],
      metadata: { language_info: { name: "python" } },
    }));

    assert.equal(notebook.cells.length, 2);
    assert.equal(notebook.language, "python");
    assert.equal(notebook.cells[0]?.type, "markdown");
    assert.equal(notebook.cells[1]?.executionCount, 3);
    assert.equal(notebook.cells[1]?.outputSummary, "ok");
  });
});
