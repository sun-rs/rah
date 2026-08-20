import assert from "node:assert/strict";
import test from "node:test";
import { createReplyStartAlignmentController } from "./reply-start-alignment";

test("reply-start alignment reaches the exact mounted row and keeps its anchor", () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  let viewportChanges = 0;
  const node = {
    clientHeight: 400,
    scrollHeight: 1_000,
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => [
      {
        dataset: { feedEntryKey: "reply" },
        getBoundingClientRect: () => ({ top: 120 - node.scrollTop }),
      },
    ],
  } as unknown as HTMLElement;
  const controller = createReplyStartAlignmentController({
    getContainer: () => node,
    onViewportChanged: () => {
      viewportChanges += 1;
    },
    requestFrame: (callback) => {
      const handle = nextFrame++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => {
      frames.delete(handle);
    },
  });

  controller.start({ entryKey: "reply", targetScrollTop: 900 });
  assert.equal(node.scrollTop, 120);
  assert.equal(controller.hasAnchor(), true);
  assert.equal(frames.size, 1);
  const settle = [...frames.values()][0];
  frames.clear();
  settle(0);
  assert.equal(frames.size, 0);
  assert.equal(viewportChanges, 2);

  controller.clear();
  assert.equal(controller.hasAnchor(), false);
});

test("reply-start alignment uses the virtual estimate until the row mounts", () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const node = {
    clientHeight: 400,
    scrollHeight: 1_000,
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => [],
  } as unknown as HTMLElement;
  const controller = createReplyStartAlignmentController({
    getContainer: () => node,
    onViewportChanged: () => undefined,
    requestFrame: (callback) => {
      const handle = nextFrame++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => {
      frames.delete(handle);
    },
  });

  controller.start({ entryKey: "reply", targetScrollTop: 640 });
  assert.equal(node.scrollTop, 640);
  assert.equal(frames.size, 1);
  controller.dispose();
  assert.equal(frames.size, 0);
  assert.equal(controller.hasAnchor(), false);
});

test("a reader gesture can revoke every pending alignment frame before scroll", () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const node = {
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => [],
  } as unknown as HTMLElement;
  const controller = createReplyStartAlignmentController({
    getContainer: () => node,
    onViewportChanged: () => undefined,
    requestFrame: (callback) => {
      const handle = nextFrame++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => {
      frames.delete(handle);
    },
  });

  controller.start({ entryKey: "reply", targetScrollTop: 700 });
  assert.equal(node.scrollTop, 700);
  assert.equal(frames.size, 1);

  controller.clear();
  assert.equal(frames.size, 0);
  assert.equal(controller.alignNow(), false);
  assert.equal(node.scrollTop, 700);
});
