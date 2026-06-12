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
});
