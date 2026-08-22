import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkbenchNoticePreferencesStore } from "./workbench-notice-preferences";

test("shares the compatibility mute until the daemon host's next midnight", async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "rah-notice-preferences-"));
  try {
    const now = new Date(2026, 7, 13, 16, 45, 0);
    const expectedMidnight = new Date(now);
    expectedMidnight.setHours(24, 0, 0, 0);

    const firstClient = new WorkbenchNoticePreferencesStore(rootDir);
    firstClient.load(now);
    assert.deepEqual(firstClient.runtimeCompatibilityState(now), {});
    assert.deepEqual(firstClient.muteRuntimeCompatibilityForToday(now), {
      mutedUntil: expectedMidnight.toISOString(),
    });
    await firstClient.flush();

    const secondClient = new WorkbenchNoticePreferencesStore(rootDir);
    secondClient.load(now);
    assert.deepEqual(secondClient.runtimeCompatibilityState(now), {
      mutedUntil: expectedMidnight.toISOString(),
    });
    assert.deepEqual(secondClient.runtimeCompatibilityState(expectedMidnight), {});
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
