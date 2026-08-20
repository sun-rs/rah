import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveModeAfterCanvasExit } from "./useWorkbenchPageController";
import {
  acknowledgeSessionConversationNavigationRequest,
  advanceSessionConversationNavigationRequest,
} from "../session-conversation-navigation";

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
    /const openSession = useCallback\([\s\S]*?markSessionNavigation\(sessionId, target\);[\s\S]*?setSelectedSessionId\(sessionId\)/,
  );
  assert.match(
    source,
    /const prepareHistorySession = useCallback\([\s\S]*?markSessionNavigation\(null\);/,
  );
  assert.match(source, /sessionNavigationRevision: sessionNavigationRequest\.revision/);
});

test("session navigation freezes the requested unread reply identity", () => {
  const request = advanceSessionConversationNavigationRequest(
    { revision: 4, sessionId: "older", target: { kind: "tail" } },
    "session-1",
    {
      kind: "reply_start",
      entryKey: "conversation:final-1",
      turnId: "turn-1",
      replyTimestampMs: 1_000,
    },
  );

  assert.deepEqual(request, {
    revision: 5,
    sessionId: "session-1",
    target: {
      kind: "reply_start",
      entryKey: "conversation:final-1",
      turnId: "turn-1",
      replyTimestampMs: 1_000,
    },
  });
});

test("an unread navigation request is consumed once without advancing its revision", () => {
  const request = {
    revision: 5,
    sessionId: "session-1",
    target: {
      kind: "reply_start" as const,
      entryKey: null,
      turnId: "turn-1",
      replyTimestampMs: 1_000,
    },
  };

  assert.equal(acknowledgeSessionConversationNavigationRequest(request, 4), request);
  assert.deepEqual(acknowledgeSessionConversationNavigationRequest(request, 5), {
    revision: 5,
    sessionId: "session-1",
    target: { kind: "tail" },
  });
});

test("sidebar navigation does not mutate the New Task workspace draft", () => {
  const controllerSource = readFileSync(
    new URL("./useWorkbenchPageController.ts", import.meta.url),
    "utf8",
  );
  const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  const sidebarSource = readFileSync(new URL("../SessionSidebar.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(controllerSource, /setWorkspaceDir/);
  assert.match(appSource, /const \[newTaskWorkspaceDir, setNewTaskWorkspaceDir\]/);
  assert.match(appSource, /pendingNewSessionWorkspaceDir \?\? sidebarWorkspaceDir/);
  assert.doesNotMatch(appSource, /previousWorkspaceDirRef/);
  assert.match(sidebarSource, /item\.status === "unread" \? "latest_unread_reply" : "tail"/);
  assert.match(appSource, /latestFinalReplyNavigationTarget\(projection\)[\s\S]*?pageController\.openSession/);
});
