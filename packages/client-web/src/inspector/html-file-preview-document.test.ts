import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { buildIsolatedHtmlPreviewDocument } from "./html-file-preview-document";

test("builds a static HTML preview with an opaque, network-free policy", () => {
  const document = buildIsolatedHtmlPreviewDocument(
    '<!doctype html><html><body><svg><text>Report</text></svg><script>parent.pwned = true</script></body></html>',
    { nonce: "preview-test" },
  );

  assert.match(document, /default-src 'none'/);
  assert.match(document, /script-src 'nonce-preview-test'/);
  assert.match(document, /connect-src 'none'/);
  assert.match(document, /frame-src 'none'/);
  assert.match(document, /object-src 'none'/);
  assert.match(document, /form-action 'none'/);
  assert.match(document, /blockedElements\.forEach/);
  assert.match(document, /name\.startsWith\("on"\)/);
  assert.match(document, /normalized\.startsWith\("data:image\/"\)/);
  assert.match(document, /normalized\.startsWith\("data:audio\/"\)/);
  assert.match(document, /normalized\.startsWith\("data:video\/"\)/);
  assert.doesNotMatch(document, /<script>parent\.pwned/);
  assert.match(document, /\\u003cscript>parent\.pwned/);
});

test("keeps the iframe sandbox opaque while permitting only the nonce bootstrap", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("./HtmlFilePreview.tsx", import.meta.url), "utf8"),
  );

  assert.match(source, /sandbox="allow-scripts"/);
  assert.doesNotMatch(source, /allow-same-origin/);
  assert.match(source, /referrerPolicy="no-referrer"/);
});

test("keeps inline styles and SVG while stripping executable and navigable nodes before import", () => {
  const document = buildIsolatedHtmlPreviewDocument(
    '<style>svg { width: 100% }</style><svg><use href="#mark" /></svg>',
    { nonce: "preview-static" },
  );

  assert.match(document, /parsed\.head\.querySelectorAll\("style"\)/);
  assert.match(document, /value\.startsWith\("#"\)/);
  assert.match(document, /document\.importNode/);
  assert.match(document, /rahHtmlPreviewReady/);
});

test("executes the embedded sanitizer bootstrap to its ready boundary", () => {
  const previewDocument = buildIsolatedHtmlPreviewDocument(
    '<!doctype html><html><body><img src="data:image/png;base64,AA=="><h1>Report</h1></body></html>',
    { nonce: "preview-runtime" },
  );
  const bootstrapMatch = previewDocument.match(
    /<script nonce="preview-runtime">([\s\S]*?)<\/script>/,
  );
  assert.ok(bootstrapMatch);

  const previewRoot = {
    attributes: [] as Array<{ name: string; value: string }>,
    dataset: {} as Record<string, string>,
    setAttribute() {},
  };
  const previewBody = {
    attributes: [] as Array<{ name: string; value: string }>,
    replaceChildren() {},
    setAttribute() {},
  };
  const parsedElement = {
    attributes: [{ name: "src", value: "data:image/png;base64,AA==" }],
    removeAttribute() {},
  };
  const parsedDocument = {
    documentElement: { attributes: [] },
    body: { attributes: [], childNodes: [] },
    head: { querySelectorAll: () => [] },
    title: "Report",
    querySelectorAll: (selector: string) => (selector === "*" ? [parsedElement] : []),
  };

  runInNewContext(bootstrapMatch[1], {
    DOMParser: class {
      parseFromString() {
        return parsedDocument;
      }
    },
    document: {
      documentElement: previewRoot,
      body: previewBody,
      head: { append() {} },
      importNode: (node: unknown) => node,
      title: "",
    },
    Set,
  });

  assert.equal(previewRoot.dataset.rahHtmlPreviewReady, "true");
});
