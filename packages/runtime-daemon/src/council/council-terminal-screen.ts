import { createRequire } from "node:module";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");

const MIN_TERMINAL_COLS = 20;
const MIN_TERMINAL_ROWS = 8;

function clampCols(cols: number): number {
  return Math.max(MIN_TERMINAL_COLS, Math.floor(cols));
}

function clampRows(rows: number): number {
  return Math.max(MIN_TERMINAL_ROWS, Math.floor(rows));
}

function writeToTerminal(terminal: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    terminal.write(data, resolve);
  });
}

export class CouncilTerminalScreen {
  private readonly terminal: HeadlessTerminal;
  private readonly serializeAddon: SerializeAddonType;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({
      cols: clampCols(cols),
      rows: clampRows(rows),
      allowProposedApi: true,
      convertEol: false,
      scrollback: 200,
      logLevel: "off",
    });
    this.serializeAddon = new SerializeAddon();
    this.terminal.loadAddon(this.serializeAddon);
  }

  write(data: string): void {
    if (!data) {
      return;
    }
    this.writeQueue = this.writeQueue
      .then(() => writeToTerminal(this.terminal, data))
      .catch(() => undefined);
  }

  resize(cols: number, rows: number): void {
    const nextCols = clampCols(cols);
    const nextRows = clampRows(rows);
    this.writeQueue = this.writeQueue
      .then(() => {
        this.terminal.resize(nextCols, nextRows);
      })
      .catch(() => undefined);
  }

  async renderSnapshot(): Promise<string> {
    await this.writeQueue.catch(() => undefined);
    const serialized = this.serializeAddon.serialize({ scrollback: 0 });
    return [
      "\x1b[0m\x1b[?25l\x1b[H\x1b[2J",
      serialized,
      "\x1b[?25h",
    ].join("");
  }

  dispose(): void {
    this.terminal.dispose();
  }
}
