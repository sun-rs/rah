import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveModeAfterCanvasExit } from "./useWorkbenchPageController";

test("Canvas exits to the page matching the active object", () => {
  assert.equal(resolveModeAfterCanvasExit({ sessionId: "session-1" }), "single");
  assert.equal(resolveModeAfterCanvasExit({ councilId: "council-1" }), "council");
  assert.equal(resolveModeAfterCanvasExit({}), "single");
});

test("explicit session navigation advances even when the selected id is unchanged", () => {
  const source = readFileSync(new URL("./useWorkbenchPageController.ts", import.meta.url), "utf8");

  assert.match(source, /const markSessionNavigation = useCallback/);
  assert.match(
    source,
    /const openSession = useCallback\([\s\S]*?markSessionNavigation\(\);[\s\S]*?setSelectedSessionId\(sessionId\)/,
  );
  assert.match(
    source,
    /const prepareHistorySession = useCallback\([\s\S]*?markSessionNavigation\(\);/,
  );
  assert.match(source, /sessionNavigationRevision,/);
});

test("sidebar navigation does not mutate the New Task workspace draft", () => {
  const controllerSource = readFileSync(
    new URL("./useWorkbenchPageController.ts", import.meta.url),
    "utf8",
  );
  const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(controllerSource, /setWorkspaceDir/);
  assert.match(appSource, /const \[newTaskWorkspaceDir, setNewTaskWorkspaceDir\]/);
  assert.match(appSource, /pendingNewSessionWorkspaceDir \?\? sidebarWorkspaceDir/);
  assert.doesNotMatch(appSource, /previousWorkspaceDirRef/);
});
