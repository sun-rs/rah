import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const manifestSource = await readFile(
  new URL("./regression_e2e_manifest.ts", import.meta.url),
  "utf8",
);
const workspaceSmokeSource = await readFile(
  new URL("./workspace_lifecycle_browser_smoke.py", import.meta.url),
  "utf8",
);

test("CI executes the deterministic P0 browser gate after a production Web build", () => {
  const ci = packageJson.scripts["test:ci"];
  const p0Browser = packageJson.scripts["test:p0:browser"];
  assert.equal(typeof ci, "string");
  assert.equal(typeof p0Browser, "string");
  assert.match(ci, /npm run test:regression:e2e-plan/);
  assert.match(ci, /npm run test:release-gate-contract/);
  assert.match(ci, /npm run test:p0:browser/);
  assert.match(p0Browser, /^npm run build:web && npm run test:smoke:workspace-lifecycle-browser$/);
});

test("the release gate keeps real-provider browser coverage above the deterministic CI gate", () => {
  assert.equal(
    packageJson.scripts["test:release"],
    "npm run test:ci && npm run test:regression:e2e-browser",
  );
});

test("workspace and PWA layout cases are bound to the deterministic browser gate", () => {
  for (const caseId of [
    "WORKSPACE-LIFECYCLE-001",
    "WORKSPACE-PROJECTION-001",
    "WORKSPACE-EMPTY-RECOVERY-001",
    "WORKSPACE-NEW-TASK-001",
    "PWA-COMPOSER-WORKSPACE-PILL-001",
    "PWA-CONVERSATION-DENSITY-001",
  ]) {
    assert.match(manifestSource, new RegExp(`id: "${caseId}"`));
    assert.match(workspaceSmokeSource, new RegExp(`"${caseId}"`));
  }
});
