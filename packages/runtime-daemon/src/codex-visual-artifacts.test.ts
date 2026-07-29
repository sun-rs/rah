import assert from "node:assert/strict";
import test from "node:test";
import {
  codexAssistantContentSignature,
  isSafeCodexVisualArtifactId,
  parseCodexAssistantContent,
} from "./codex-visual-artifacts";

test("parses provider-native inline visuals without changing their order", () => {
  const parsed = parseCodexAssistantContent(
    [
      "Before the chart.",
      '::codex-inline-vis{file="equity-curve.html"}',
      "After the chart.",
    ].join("\n"),
  );

  assert.equal(parsed.text, "Before the chart.\n\nAfter the chart.");
  assert.deepEqual(parsed.content, [
    { kind: "text", text: "Before the chart." },
    {
      kind: "visual",
      artifact: {
        id: "equity-curve.html",
        format: "interactive_html",
        mimeType: "text/html",
        label: "equity curve",
      },
    },
    { kind: "text", text: "After the chart." },
  ]);
  assert.equal(
    codexAssistantContentSignature(parsed),
    [
      "text:Before the chart.",
      "visual:interactive_html:equity-curve.html",
      "text:After the chart.",
    ].join("\u001f"),
  );
});

test("supports visual-only assistant messages", () => {
  const parsed = parseCodexAssistantContent(
    '::codex-inline-vis{file="interactive_plot-2.html"}',
  );

  assert.equal(parsed.text, "");
  assert.equal(parsed.content?.length, 1);
  assert.equal(parsed.content?.[0]?.kind, "visual");
});

test("leaves malformed and unsafe directives as ordinary text", () => {
  const values = [
    '::codex-inline-vis{file="../escape.html"}',
    '::codex-inline-vis{file="/tmp/escape.html"}',
    '::codex-inline-vis{file="chart.svg"}',
    "::codex-inline-vis{file='chart.html'}",
    '::codex-inline-vis{ file="chart.html" }',
    'Text ::codex-inline-vis{file="chart.html"}',
    "::codex-inline-vis{wat=\"chart.html\"}",
  ];

  for (const value of values) {
    assert.deepEqual(parseCodexAssistantContent(value), { text: value });
  }
  assert.equal(isSafeCodexVisualArtifactId("chart.html"), true);
  assert.equal(isSafeCodexVisualArtifactId("../chart.html"), false);
});

test("does not interpret an exact-looking directive inside fenced Markdown", () => {
  const value = [
    "Protocol example:",
    "```text",
    '::codex-inline-vis{file="example.html"}',
    "```",
    "",
    "The example remains copyable.",
  ].join("\n");

  assert.deepEqual(parseCodexAssistantContent(value), { text: value });
});

test("supports a real directive after a fenced protocol example", () => {
  const parsed = parseCodexAssistantContent(
    [
      "```text",
      '::codex-inline-vis{file="example.html"}',
      "```",
      "",
      '::codex-inline-vis{file="real-visual.html"}',
    ].join("\n"),
  );

  assert.equal(parsed.content?.length, 2);
  assert.equal(parsed.content?.[0]?.kind, "text");
  assert.equal(parsed.content?.[1]?.kind, "visual");
  assert.equal(
    parsed.content?.[1]?.kind === "visual"
      ? parsed.content[1].artifact.id
      : undefined,
    "real-visual.html",
  );
});

test("withholds an incomplete streaming directive instead of flashing protocol text", () => {
  assert.deepEqual(
    parseCodexAssistantContent(
      'Visible text\n::codex-inline-vis{file="equity',
      { streaming: true },
    ),
    { text: "Visible text" },
  );

  const completed = parseCodexAssistantContent(
    'Visible text\n::codex-inline-vis{file="equity.html"}',
    { streaming: true },
  );
  assert.equal(completed.text, "Visible text");
  assert.equal(completed.content?.[1]?.kind, "visual");
});

test("does not withhold an incomplete-looking marker inside a code fence", () => {
  const value = [
    "```text",
    '::codex-inline-vis{file="equity',
  ].join("\n");

  assert.deepEqual(parseCodexAssistantContent(value, { streaming: true }), {
    text: value,
  });
});
