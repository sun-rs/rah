import assert from "node:assert/strict";
import test from "node:test";
import type { GitStatusResponse } from "@rah/runtime-protocol";
import {
  loadCachedSessionInspectorPrimary,
  readCachedSessionInspectorPrimary,
  resetSessionInspectorPrimaryCacheForTests,
  subscribeSessionInspectorPrimary,
} from "./session-inspector-primary-cache";

function status(): GitStatusResponse {
  return {
    sessionId: "session-1",
    branch: "main",
    baseBranch: "main",
    comparisonMode: "uncommitted",
    changedFiles: ["src/index.ts"],
    totalBranch: 1,
  };
}

test("shares one Changes/Files request pair and publishes one complete snapshot", async () => {
  resetSessionInspectorPrimaryCacheForTests();
  let gitRequests = 0;
  let directoryRequests = 0;
  const completeStates: boolean[] = [];
  const unsubscribe = subscribeSessionInspectorPrimary(
    "session-1",
    "/workspace",
    (snapshot) => completeStates.push(snapshot.complete),
  );
  const dependencies = {
    readGitStatus: async () => {
      gitRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return status();
    },
    listDirectory: async () => {
      directoryRequests += 1;
      return {
        path: "/workspace",
        entries: [
          { name: "z.ts", type: "file" as const },
          { name: "src", type: "directory" as const },
        ],
      };
    },
  };

  const [first, concurrent] = await Promise.all([
    loadCachedSessionInspectorPrimary({
      sessionId: "session-1",
      workspaceRoot: "/workspace",
      dependencies,
    }),
    loadCachedSessionInspectorPrimary({
      sessionId: "session-1",
      workspaceRoot: "/workspace",
      dependencies,
    }),
  ]);

  assert.equal(gitRequests, 1);
  assert.equal(directoryRequests, 1);
  assert.deepEqual(concurrent, first);
  assert.equal(first.gitStatus?.branch, "main");
  assert.deepEqual(first.rootEntries.map((entry) => entry.name), ["src", "z.ts"]);
  assert.equal(
    readCachedSessionInspectorPrimary("session-1", "/workspace")?.complete,
    true,
  );
  assert.deepEqual(completeStates, [false, true]);
  unsubscribe();
  resetSessionInspectorPrimaryCacheForTests();
});

test("keeps partial stage failures isolated instead of blocking resource preload", async () => {
  resetSessionInspectorPrimaryCacheForTests();
  const snapshot = await loadCachedSessionInspectorPrimary({
    sessionId: "session-1",
    workspaceRoot: "/workspace",
    dependencies: {
      readGitStatus: async () => {
        throw new Error("git unavailable");
      },
      listDirectory: async () => ({
        path: "/workspace",
        entries: [{ name: "src", type: "directory" }],
      }),
    },
  });

  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.gitStatus, null);
  assert.equal(snapshot.gitStatusError, "git unavailable");
  assert.deepEqual(snapshot.rootEntries, [{ name: "src", type: "directory" }]);
  resetSessionInspectorPrimaryCacheForTests();
});

test("restarts a shared stage cancelled by a previous selected view", async () => {
  resetSessionInspectorPrimaryCacheForTests();
  const firstController = new AbortController();
  let gitRequests = 0;
  const dependencies = {
    readGitStatus: async (
      _sessionId: string,
      options: { signal?: AbortSignal },
    ) => {
      gitRequests += 1;
      if (gitRequests === 1) {
        return new Promise<GitStatusResponse>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
        });
      }
      return status();
    },
    listDirectory: async () => ({
      path: "/workspace",
      entries: [],
    }),
  };
  const cancelled = loadCachedSessionInspectorPrimary({
    sessionId: "reselected-session",
    workspaceRoot: "/workspace",
    signal: firstController.signal,
    dependencies,
  });
  const reselected = loadCachedSessionInspectorPrimary({
    sessionId: "reselected-session",
    workspaceRoot: "/workspace",
    dependencies,
  });

  firstController.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  const result = await reselected;

  assert.equal(gitRequests, 2);
  assert.equal(result.gitStatus?.branch, "main");
  resetSessionInspectorPrimaryCacheForTests();
});
