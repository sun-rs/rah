import assert from "node:assert/strict";
import test from "node:test";
import { runSessionViewPreloadStages } from "./session-view-preload";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("preloads Chat, then launches Changes/Files before Outputs/Sources without blocking it", async () => {
  const chat = deferred();
  const primary = deferred();
  const resources = deferred();
  const calls: string[] = [];

  const pending = runSessionViewPreloadStages({
    dependencies: {
      hydrateConversation: () => {
        calls.push("chat");
        return chat.promise;
      },
      loadChangesAndFiles: () => {
        calls.push("changes-files");
        return primary.promise;
      },
      loadOutputsAndSources: () => {
        calls.push("outputs-sources");
        return resources.promise;
      },
    },
  });

  assert.deepEqual(calls, ["chat"]);
  chat.resolve();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.deepEqual(calls, ["chat", "changes-files", "outputs-sources"]);
  resources.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ["chat", "changes-files", "outputs-sources"]);
  primary.resolve();
  await pending;
});

test("does not start a lower-priority stage after selection cancellation", async () => {
  const chat = deferred();
  const controller = new AbortController();
  const calls: string[] = [];
  const pending = runSessionViewPreloadStages({
    signal: controller.signal,
    dependencies: {
      hydrateConversation: () => {
        calls.push("chat");
        return chat.promise;
      },
      loadChangesAndFiles: async () => {
        calls.push("changes-files");
      },
      loadOutputsAndSources: async () => {
        calls.push("outputs-sources");
      },
    },
  });

  controller.abort();
  chat.resolve();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(calls, ["chat"]);
});

test("attempts lower-priority stages after a non-cancellation stage failure", async () => {
  const calls: string[] = [];
  await runSessionViewPreloadStages({
    dependencies: {
      hydrateConversation: async () => {
        calls.push("chat");
        throw new Error("history unavailable");
      },
      loadChangesAndFiles: async () => {
        calls.push("changes-files");
      },
      loadOutputsAndSources: async () => {
        calls.push("outputs-sources");
      },
    },
  });

  assert.deepEqual(calls, ["chat", "changes-files", "outputs-sources"]);
});

test("rapid selection replacement cannot start stale lower-priority work", async () => {
  const staleChat = deferred();
  const staleController = new AbortController();
  const calls: string[] = [];
  const stale = runSessionViewPreloadStages({
    signal: staleController.signal,
    dependencies: {
      hydrateConversation: () => {
        calls.push("a:chat");
        return staleChat.promise;
      },
      loadChangesAndFiles: async () => {
        calls.push("a:changes-files");
      },
      loadOutputsAndSources: async () => {
        calls.push("a:outputs-sources");
      },
    },
  });

  await runSessionViewPreloadStages({
    dependencies: {
      hydrateConversation: async () => {
        calls.push("b:chat");
      },
      loadChangesAndFiles: async () => {
        calls.push("b:changes-files");
      },
      loadOutputsAndSources: async () => {
        calls.push("b:outputs-sources");
      },
    },
  });

  staleController.abort();
  staleChat.resolve();
  await assert.rejects(stale, { name: "AbortError" });
  assert.deepEqual(calls, [
    "a:chat",
    "b:chat",
    "b:changes-files",
    "b:outputs-sources",
  ]);
});
