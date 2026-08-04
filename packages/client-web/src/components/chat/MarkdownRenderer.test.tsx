import { describe, test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { FileResourceIcon, fileResourceKind } from "./FileResourceIcon";
import {
  coalesceMarkdownImageBlocks,
  createMarkdownComponents,
  isImageOnlyMarkdownBlock,
  MarkdownRenderer,
  selectionIntersectsNode,
} from "./MarkdownRenderer";

describe("MarkdownRenderer", () => {
  test("renders formatted Markdown on the first render without a plain-text suspense phase", () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer
        className="prose-chat"
        content={"| Name | Value |\n| --- | --- |\n| RAH | Stable |"}
      />,
    );

    assert.match(html, /class="prose-chat-table-wrapper"/);
    assert.match(html, /<table>/);
    assert.match(html, /<th>Name<\/th>/);
    assert.match(html, /<td>Stable<\/td>/);
    assert.doesNotMatch(html, /<!--\$!-->/);
  });

  test("preserves visible text for external autolinks", () => {
    const url = "https://www.chinamoney.com.cn/chinese/bkcurvfxhis/?cfgItemType=72&curveType=FR007";
    const html = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={createMarkdownComponents(undefined)}
      >
        {`- FR007 利率互换历史数据页：  \n  ${url}`}
      </ReactMarkdown>,
    );

    assert.match(html, /FR007 利率互换历史数据页/);
    assert.match(html, /href="https:\/\/www\.chinamoney\.com\.cn\/chinese\/bkcurvfxhis\/\?cfgItemType=72&amp;curveType=FR007"/);
    assert.match(html, /https:\/\/www\.chinamoney\.com\.cn\/chinese\/bkcurvfxhis\/\?cfgItemType=72&amp;curveType=FR007/);
  });

  test("turns inline local file code spans into inspector buttons", () => {
    const localPath =
      "/Volumes/Data/strategy/research/bond_futures_strategy_research_20260614/bond_three_layer_combo_audit/three_layer_combo_curves.png";
    const html = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={createMarkdownComponents(() => undefined)}
      >
        {`曲线图已生成：\n\n\`${localPath}\``}
      </ReactMarkdown>,
    );

    assert.match(html, /<button/);
    assert.match(html, /class="prose-chat-local-file-code"/);
    assert.match(html, /Open in Inspector: \/Volumes\/Data\/strategy\/research/);
    assert.match(html, /three_layer_combo_curves\.png/);
    assert.match(html, /data-file-resource-kind="image"/);
  });

  test("renders local Markdown images as lazy Inspector previews", () => {
    const localPath = "/Volumes/Data/reports/equity-curve.png";
    const html = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={createMarkdownComponents(() => undefined)}
      >
        {`![Equity curve](${localPath})`}
      </ReactMarkdown>,
    );

    assert.match(html, /data-testid="conversation-inline-image"/);
    assert.match(
      html,
      /title="Open in Inspector: \/Volumes\/Data\/reports\/equity-curve\.png"/,
    );
    assert.match(html, /aria-label="Equity curve"/);
    assert.doesNotMatch(html, /src="\/Volumes\/Data\/reports\/equity-curve\.png"/);
  });

  test("renders remote Markdown images as clickable browser previews", () => {
    const url = "https://example.com/chart.png";
    const html = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={createMarkdownComponents(undefined)}
      >
        {`![Remote chart](${url})`}
      </ReactMarkdown>,
    );

    assert.match(html, /data-testid="conversation-inline-image"/);
    assert.match(html, /src="https:\/\/example\.com\/chart\.png"/);
    assert.match(html, /alt="Remote chart"/);
  });

  test("coalesces consecutive image-only blocks into a wrapping thumbnail grid", () => {
    assert.equal(
      isImageOnlyMarkdownBlock("![First](https://example.com/first.png)"),
      true,
    );
    assert.deepEqual(
      coalesceMarkdownImageBlocks([
        "![First](https://example.com/first.png)",
        "![Second](https://example.com/second.png)",
        "Caption",
      ]),
      [
        "![First](https://example.com/first.png)\n![Second](https://example.com/second.png)",
        "Caption",
      ],
    );

    const html = renderToStaticMarkup(
      <MarkdownRenderer
        className="prose-chat"
        content={
          "![First](https://example.com/first.png)\n\n![Second](https://example.com/second.png)"
        }
      />,
    );

    assert.match(html, /data-markdown-image-grid="true"/);
    assert.equal(
      [...html.matchAll(/data-testid="conversation-inline-image"/g)].length,
      2,
    );
    assert.equal(
      [...html.matchAll(/prose-chat-image-thumbnail-remote/g)].length,
      2,
    );
  });

  test("classifies resource icons from stable file extensions", () => {
    assert.equal(fileResourceKind("src/main.rs"), "code");
    assert.equal(fileResourceKind("report.csv"), "spreadsheet");
    assert.equal(fileResourceKind("chart.PNG"), "image");
    assert.equal(fileResourceKind("README.md"), "document");
  });

  test("renders the shared Codex file glyphs at a stable 16px viewBox", () => {
    const html = renderToStaticMarkup(
      <div>
        <FileResourceIcon path="bin/rah.mjs" />
        <FileResourceIcon path="src/App.tsx" />
        <FileResourceIcon path="docs/design.md" />
      </div>,
    );

    assert.match(html, /data-file-extension="mjs"/);
    assert.match(html, /data-file-icon-name="javascript"/);
    assert.match(html, /data-file-icon-tone="semantic"/);
    assert.match(html, /data-file-extension="tsx"/);
    assert.match(html, /data-file-icon-name="react"/);
    assert.match(html, /data-file-extension="md"/);
    assert.match(html, /data-file-icon-name="markdown"/);
    assert.match(html, /viewBox="0 0 16 16"/);
    assert.doesNotMatch(html, />JS<\/span>/);
    assert.doesNotMatch(html, />M↓<\/span>/);
  });

  test("inherits the link color for inline chat file glyphs", () => {
    const html = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={createMarkdownComponents(() => undefined)}
      >
        {"[App.tsx](/Volumes/Data/src/App.tsx)"}
      </ReactMarkdown>,
    );

    assert.match(html, /class="prose-chat-local-file-link"/);
    assert.match(html, /data-selectable-conversation-text="true"/);
    assert.match(html, /data-file-icon-name="react"/);
    assert.match(html, /data-file-icon-tone="inherit"/);
    assert.doesNotMatch(html, /color:var\(--file-icon-cyan\)/);
  });

  test("distinguishes pointer text selection from a local-file activation", () => {
    const target = {} as Node;
    const intersectingSelection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({
        intersectsNode: (node: Node) => node === target,
      }),
    } as unknown as Pick<Selection, "isCollapsed" | "rangeCount" | "getRangeAt">;

    assert.equal(selectionIntersectsNode(intersectingSelection, target), true);
    assert.equal(
      selectionIntersectsNode({ ...intersectingSelection, isCollapsed: true }, target),
      false,
    );
    assert.equal(selectionIntersectsNode(null, target), false);
  });

  test("does not link ordinary inline code spans", () => {
    const html = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={createMarkdownComponents(() => undefined)}
      >
        {"Agent wrote `what` as inline code."}
      </ReactMarkdown>,
    );

    assert.doesNotMatch(html, /prose-chat-local-file-code/);
    assert.match(html, /<code>what<\/code>/);
  });

  test("does not link local paths inside fenced code blocks", () => {
    const localPath = "/Volumes/Data/example.png";
    const html = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={createMarkdownComponents(() => undefined)}
      >
        {"```\n" + localPath + "\n```"}
      </ReactMarkdown>,
    );

    assert.doesNotMatch(html, /prose-chat-local-file-code/);
    assert.match(html, /<pre><code>/);
  });

  test("renders plain text code blocks without a text header", () => {
    const html = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={createMarkdownComponents(undefined)}
      >
        {"```text\nplain text\n```"}
      </ReactMarkdown>,
    );

    assert.match(html, /prose-chat-codeblock-plain/);
    assert.match(html, /prose-chat-codeblock-copy/);
    assert.doesNotMatch(html, /prose-chat-codeblock-header/);
    assert.doesNotMatch(html, />text<\/span>/);
  });

  test("renders Mermaid fences as a lazy diagram surface instead of source code", () => {
    const html = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={createMarkdownComponents(undefined)}
      >
        {"```mermaid\nflowchart TD\n  A --> B\n```"}
      </ReactMarkdown>,
    );

    assert.match(html, /data-testid="mermaid-diagram"/);
    assert.match(html, /aria-label="Rendering diagram"/);
    assert.doesNotMatch(html, /prose-chat-codeblock/);
  });
});
