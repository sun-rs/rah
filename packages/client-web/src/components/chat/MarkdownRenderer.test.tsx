import { describe, test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { createMarkdownComponents } from "./MarkdownRenderer";

describe("MarkdownRenderer", () => {
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
});
