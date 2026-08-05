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
    readWorkspaceGitStatus: async () => {
      throw new Error("unexpected workspace fallback");
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
      readWorkspaceGitStatus: async () => {
        throw new Error("unexpected workspace fallback");
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

test("refresh failures preserve the last good Changes and Files snapshot", async () => {
  resetSessionInspectorPrimaryCacheForTests();
  let failRefresh = false;
  const dependencies = {
    readGitStatus: async () => {
      if (failRefresh) {
        throw new Error("git refresh unavailable");
      }
      return status();
    },
    readWorkspaceGitStatus: async () => {
      throw new Error("unexpected workspace fallback");
    },
    listDirectory: async () => {
      if (failRefresh) {
        throw new Error("directory refresh unavailable");
      }
      return {
        path: "/workspace",
        entries: [{ name: "src", type: "directory" as const }],
      };
    },
  };
  await loadCachedSessionInspectorPrimary({
    sessionId: "stable-session",
    workspaceRoot: "/workspace",
    dependencies,
  });
  failRefresh = true;

  const refreshed = await loadCachedSessionInspectorPrimary({
    sessionId: "stable-session",
    workspaceRoot: "/workspace",
    refresh: true,
    dependencies,
  });

  assert.equal(refreshed.gitStatus?.branch, "main");
  assert.deepEqual(refreshed.rootEntries, [
    { name: "src", type: "directory" },
  ]);
  assert.equal(refreshed.gitStatusError, "git refresh unavailable");
  assert.equal(refreshed.directoryError, "directory refresh unavailable");
  resetSessionInspectorPrimaryCacheForTests();
});

test("a cancelled view stops waiting without cancelling the shared stage", async () => {
  resetSessionInspectorPrimaryCacheForTests();
  const firstController = new AbortController();
  let gitRequests = 0;
  let releaseGit!: () => void;
  const gitGate = new Promise<void>((resolve) => {
    releaseGit = resolve;
  });
  const dependencies = {
    readGitStatus: async (
      _sessionId: string,
      options: { signal?: AbortSignal },
    ) => {
      gitRequests += 1;
      assert.equal(options.signal?.aborted, false);
      await gitGate;
      return status();
    },
    readWorkspaceGitStatus: async () => {
      throw new Error("unexpected workspace fallback");
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
  releaseGit();
  const result = await reselected;

  assert.equal(gitRequests, 1);
  assert.equal(result.gitStatus?.branch, "main");
  resetSessionInspectorPrimaryCacheForTests();
});

test("falls back to workspace Changes only for a historical session missing from the daemon", async () => {
  resetSessionInspectorPrimaryCacheForTests();
  let workspaceRequests = 0;
  const snapshot = await loadCachedSessionInspectorPrimary({
    sessionId: "history:codex:thread-1",
    workspaceRoot: "/workspace",
    dependencies: {
      readGitStatus: async () => {
        throw new Error("Unknown session history:codex:thread-1");
      },
      readWorkspaceGitStatus: async (workspaceRoot) => {
        workspaceRequests += 1;
        assert.equal(workspaceRoot, "/workspace");
        return status();
      },
      listDirectory: async () => ({
        path: "/workspace",
        entries: [],
      }),
    },
  });

  assert.equal(workspaceRequests, 1);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.gitStatus?.branch, "main");
  assert.equal(snapshot.gitStatusError, null);
  resetSessionInspectorPrimaryCacheForTests();
});
