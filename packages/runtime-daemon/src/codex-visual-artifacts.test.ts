import assert from "node:assert/strict";
import test from "node:test";
import {
  codexAssistantContentSignature,
  codexVisualArtifactIdForPath,
  codexVisualArtifactPathFromId,
  collectCodexVisualArtifactPathEvidence,
  isSafeCodexVisualArtifactId,
  parseCodexAssistantContent,
} from "./codex-visual-artifacts";

test("parses legacy visualize directives with an opaque exact-path artifact id", () => {
  const visualPath =
    "/Volumes/Data/skew/.codex/visualizations/2026/08/16/causal-dynamic-weights/equal-vs-causal-dynamic.html";
  const parsed = parseCodexAssistantContent(
    `visualize${JSON.stringify({ path: visualPath, mode: "wide" })}`,
  );
  const artifact = parsed.content?.[0]?.kind === "visual"
    ? parsed.content[0].artifact
    : undefined;

  assert.ok(artifact);
  assert.equal(codexVisualArtifactPathFromId(artifact.id), visualPath);
  assert.equal(artifact.label, "equal vs causal dynamic");
  assert.equal(parsed.text, "");
});

test("uses explicit provider path evidence for basename-only visual directives", () => {
  const paths = new Map<string, string>();
  const visualPath =
    ".codex/visualizations/2026/08/15/sxx-optimal-combinations/optimal-candidate-combinations.html";
  collectCodexVisualArtifactPathEvidence(
    { output: `-rw-r--r-- 1 user staff 269K ${visualPath}` },
    paths,
  );
  const parsed = parseCodexAssistantContent(
    '::codex-inline-vis{file="optimal-candidate-combinations.html"}',
    {
      resolveVisualArtifactId: (fileName) => {
        const evidencedPath = paths.get(fileName);
        return evidencedPath
          ? codexVisualArtifactIdForPath(evidencedPath)
          : undefined;
      },
    },
  );
  const artifact = parsed.content?.[0]?.kind === "visual"
    ? parsed.content[0].artifact
    : undefined;

  assert.ok(artifact);
  assert.equal(codexVisualArtifactPathFromId(artifact.id), visualPath);
});

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
  assert.equal(
    isSafeCodexVisualArtifactId(
      codexVisualArtifactIdForPath(
        "/workspace/.codex/visualizations/2026/08/20/example/chart.html",
      )!,
    ),
    true,
  );
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
