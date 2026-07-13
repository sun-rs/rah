import assert from "node:assert/strict";
import { test } from "node:test";

import { serializeSessionTransportCommand } from "./session-store-session-commands";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("serializes transport commands for one session without blocking another", async () => {
  const first = deferred<string>();
  const order: string[] = [];
  const firstResult = serializeSessionTransportCommand("session-a", async () => {
    order.push("a:first:start");
    const value = await first.promise;
    order.push("a:first:end");
    return value;
  });
  const secondResult = serializeSessionTransportCommand("session-a", async () => {
    order.push("a:second");
    return "second";
  });
  const otherResult = serializeSessionTransportCommand("session-b", async () => {
    order.push("b:first");
    return "other";
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ["a:first:start", "b:first"]);
  first.resolve("first");
  assert.equal(await firstResult, "first");
  assert.equal(await secondResult, "second");
  assert.equal(await otherResult, "other");
  assert.deepEqual(order, ["a:first:start", "b:first", "a:first:end", "a:second"]);
});

test("a failed command does not poison later commands for the session", async () => {
  const first = deferred<void>();
  const order: string[] = [];
  const failed = serializeSessionTransportCommand("session-failure", async () => {
    order.push("first");
    await first.promise;
  });
  const recovered = serializeSessionTransportCommand("session-failure", async () => {
    order.push("second");
    return "recovered";
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  first.reject(new Error("expected"));
  await assert.rejects(failed, /expected/);
  assert.equal(await recovered, "recovered");
  assert.deepEqual(order, ["first", "second"]);
});
