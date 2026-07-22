import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyNativeTuiExit } from "./native-tui-exit-classification";

test("native TUI exits are clean only when expected or explicitly successful", () => {
  assert.equal(
    classifyNativeTuiExit({ expectedClose: true, exitCode: 137, signal: "SIGKILL" }),
    undefined,
  );
  assert.equal(classifyNativeTuiExit({ expectedClose: false, exitCode: 0 }), undefined);
  assert.equal(
    classifyNativeTuiExit({ expectedClose: false, exitCode: 1 }),
    "Native TUI process exited with code 1.",
  );
  assert.equal(
    classifyNativeTuiExit({ expectedClose: false, signal: "SIGINT" }),
    "Native TUI process exited from signal SIGINT.",
  );
  assert.equal(
    classifyNativeTuiExit({ expectedClose: false, exitCode: null }),
    "Native TUI process exited unexpectedly.",
  );
});

test("native TUI provider output remains the primary failure explanation", () => {
  assert.equal(
    classifyNativeTuiExit({
      expectedClose: false,
      outputError: "Error: unsupported model claude-wrong-model",
      exitCode: 1,
    }),
    "Error: unsupported model claude-wrong-model",
  );
});
