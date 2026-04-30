import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import process from "node:process";
import {
  clearTerminalScreen,
  disableTerminalApplicationModes,
  enterAlternateScreen,
  leaveAlternateScreen,
  renderTerminalWrapperPanel,
  restoreInheritedTerminalModes,
} from "./terminal-wrapper-panel";

const originalWrite = process.stdout.write.bind(process.stdout);
const originalColumns = process.stdout.columns;
const originalIsTTY = process.stdout.isTTY;

function charDisplayWidth(value: string): number {
  const codePoint = value.codePointAt(0);
  if (codePoint === undefined) {
    return 0;
  }
  if (
    codePoint >= 0x1100 &&
    (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    )
  ) {
    return 2;
  }
  return 1;
}

function stringDisplayWidth(value: string): number {
  return [...value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")].reduce(
    (total, char) => total + charDisplayWidth(char),
    0,
  );
}

function captureWrites(run: () => void): string[] {
  const writes: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = originalWrite as typeof process.stdout.write;
  }
  return writes;
}

afterEach(() => {
  process.stdout.write = originalWrite as typeof process.stdout.write;
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: originalColumns,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: originalIsTTY,
  });
});

describe("terminal wrapper panel helpers", () => {
  test("renders a minimal fixed panel", () => {
    const panel = renderTerminalWrapperPanel({
      title: "RAH Claude Remote Control",
      status: "Thinking",
      sessionId: "session-123",
      prompt: "hello there",
      footer: "Press Esc to resume local control.",
    });

    assert.match(panel, /RAH Claude Remote Control/);
    assert.match(panel, /Status: Thinking/);
    assert.match(panel, /Session: session-123/);
    assert.match(panel, /Current prompt:/);
  });

  test("keeps panel borders aligned with wide characters", () => {
    const panel = renderTerminalWrapperPanel({
      title: "RAH Claude Remote Control",
      status: "Thinking",
      sessionId: "session-123",
      prompt: "告诉我现在时间",
      footer: "Press Esc to resume local control.",
    });

    const widths = panel.split("\n").map(stringDisplayWidth);
    assert.equal(new Set(widths).size, 1);
  });

  test("keeps panel borders aligned with colored status and footer", () => {
    const panel = renderTerminalWrapperPanel({
      title: "RAH Codex Remote Control",
      status: "Thinking",
      statusTone: "danger",
      sessionId: "session-123",
      prompt: "hello there",
      footer: "Only after this turn: Esc works.",
      footerTone: "danger",
    });

    assert.match(panel, /\u001b\[31mStatus: Thinking\u001b\[0m/);
    assert.match(panel, /\u001b\[31mOnly after this turn: Esc works\.\u001b\[0m/);
    const widths = panel.split("\n").map(stringDisplayWidth);
    assert.equal(new Set(widths).size, 1);
  });

  test("clamps very long prompt previews to three aligned lines", () => {
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: 44,
    });
    const panel = renderTerminalWrapperPanel({
      title: "RAH Claude Remote Control",
      status: "Thinking",
      sessionId: "session-123",
      prompt:
        "这是一个没有空格但是非常非常非常非常非常非常非常非常非常长的提示词，用来验证面板不会因为长文本而把边框顶歪或者无限增长，现在继续追加更多更多更多更多更多更多更多更多更多更多更多更多内容来确保一定会超过三行",
      footer: "Press Esc to resume local control.",
    });

    const lines = panel.split("\n");
    const promptIndex = lines.findIndex((line) => line.includes("Current prompt:"));
    const promptLines = lines.slice(promptIndex + 1, promptIndex + 4);
    assert.equal(promptLines.length, 3);
    assert.ok(promptLines[2]?.includes("…"));
    const widths = lines.map(stringDisplayWidth);
    assert.equal(new Set(widths).size, 1);
  });

  test("writes alternate screen enter, clear, and leave sequences", () => {
    const writes = captureWrites(() => {
      enterAlternateScreen();
      clearTerminalScreen();
      leaveAlternateScreen();
    });

    assert.deepEqual(writes, ["\u001b[?1049h", "\u001b[2J\u001b[H", "\u001b[?1049l"]);
  });

  test("restores terminal input modes after inherited tui exits", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    const writes = captureWrites(() => {
      restoreInheritedTerminalModes();
    });

    assert.deepEqual(writes, [
      "\u001b[<1u\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1005l\u001b[?1006l\u001b[?1015l\u001b[?1004l\u001b[?2004l\u001b[?2026l\u001b[?25h\u001b[0m",
      "\r",
    ]);
  });

  test("does not write terminal restore sequences outside a tty", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const writes = captureWrites(() => {
      restoreInheritedTerminalModes();
    });

    assert.deepEqual(writes, []);
  });

  test("disables application mouse and focus modes without leaving alternate screen", () => {
    const writes = captureWrites(() => {
      disableTerminalApplicationModes();
    });

    assert.equal(
      writes[0],
      "\u001b[<1u\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1005l\u001b[?1006l\u001b[?1015l\u001b[?1004l\u001b[?2004l\u001b[?2026l\u001b[?25h\u001b[0m",
    );
    assert.doesNotMatch(writes[0] ?? "", /\u001b\[\?1049l/);
  });
});
