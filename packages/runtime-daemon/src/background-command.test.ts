import assert from "node:assert/strict";
import test from "node:test";
import { runBackgroundCommand } from "./background-command";

test("background commands return exact bounded output", async () => {
  const result = await runBackgroundCommand({
    command: process.execPath,
    args: ["-e", "process.stdout.write('ready'); process.stderr.write('note')"],
    label: "background command test",
  });

  assert.equal(result.stdout, "ready");
  assert.equal(result.stderr, "note");
  assert.equal(result.code, 0);
});

test("background commands reject output that exceeds its semantic limit", async () => {
  await assert.rejects(
    runBackgroundCommand({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(131072))"],
      label: "bounded probe",
      maxStdoutBytes: 16 * 1024,
    }),
    /bounded probe exceeded the 16 KiB stdout limit/,
  );
});

test("background command output yields between ingress slices", async () => {
  let timerObserved = false;
  const timer = setTimeout(() => {
    timerObserved = true;
  }, 0);
  const result = await runBackgroundCommand({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(1024 * 1024))"],
    label: "sliced probe",
    maxStdoutBytes: 2 * 1024 * 1024,
  });
  clearTimeout(timer);

  assert.equal(result.stdout.length, 1024 * 1024);
  assert.equal(timerObserved, true);
});
