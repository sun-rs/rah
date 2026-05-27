import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { extractHighlightedLines } from "./shiki";

describe("shiki line extraction", () => {
  test("preserves nested token spans on a python import line", () => {
    const html = [
      '<pre class="shiki"><code>',
      '<span class="line"><span style="color:#0000FF">import</span><span style="color:#000000"> pathlib</span></span>',
      '<span class="line"><span style="color:#0000FF">from</span><span style="color:#000000"> os </span><span style="color:#0000FF">import</span><span style="color:#000000"> path</span></span>',
      "</code></pre>",
    ].join("");

    assert.deepEqual(extractHighlightedLines(html), [
      '<span style="color:#0000FF">import</span><span style="color:#000000"> pathlib</span>',
      '<span style="color:#0000FF">from</span><span style="color:#000000"> os </span><span style="color:#0000FF">import</span><span style="color:#000000"> path</span>',
    ]);
  });

  test("does not confuse token spans with line spans", () => {
    const html = [
      '<pre><code>',
      '<span class="line"><span style="color:#000000">{</span></span>',
      '<span class="line"><span style="color:#0451A5">"name"</span><span style="color:#000000">: </span><span style="color:#A31515">"rah"</span></span>',
      "</code></pre>",
    ].join("");

    assert.deepEqual(extractHighlightedLines(html), [
      '<span style="color:#000000">{</span>',
      '<span style="color:#0451A5">"name"</span><span style="color:#000000">: </span><span style="color:#A31515">"rah"</span>',
    ]);
  });

  test("preserves leading whitespace inside highlighted lines", () => {
    const html = [
      '<pre><code>',
      '<span class="line">    <span style="color:#0000FF">return</span><span style="color:#000000"> value</span></span>',
      "</code></pre>",
    ].join("");

    assert.deepEqual(extractHighlightedLines(html), [
      '    <span style="color:#0000FF">return</span><span style="color:#000000"> value</span>',
    ]);
  });
});
