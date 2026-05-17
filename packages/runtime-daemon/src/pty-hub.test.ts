import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PtyHub, type PtyServerFrame } from "./pty-hub";

describe("PtyHub", () => {
  test("assigns monotonic sequence numbers and replays from a cursor", () => {
    const hub = new PtyHub({ maxReplayChunks: 3 });
    const liveFrames: PtyServerFrame[] = [];
    const unsubscribeLive = hub.subscribe("terminal-1", (frame) => {
      liveFrames.push(frame);
    });

    hub.appendOutput("terminal-1", "a");
    hub.appendOutput("terminal-1", "b");
    hub.appendOutput("terminal-1", "c");
    hub.appendOutput("terminal-1", "d");

    assert.deepEqual(
      liveFrames
        .filter((frame) => frame.type === "pty.output")
        .map((frame) => frame.seq),
      [0, 1, 2, 3],
    );

    const replayFrames: PtyServerFrame[] = [];
    const unsubscribeReplay = hub.subscribe("terminal-1", (frame) => {
      replayFrames.push(frame);
    }, { fromSeq: 2 });

    const replay = replayFrames.find((frame) => frame.type === "pty.replay");
    assert.equal(replay?.baseSeq, 2);
    assert.equal(replay?.nextSeq, 4);
    assert.deepEqual(replay?.chunks, ["c", "d"]);

    unsubscribeLive();
    unsubscribeReplay();
  });

  test("reports trimmed replay boundaries", () => {
    const hub = new PtyHub({ maxReplayChunks: 2 });
    hub.appendOutput("terminal-1", "a");
    hub.appendOutput("terminal-1", "b");
    hub.appendOutput("terminal-1", "c");

    const frames: PtyServerFrame[] = [];
    const unsubscribe = hub.subscribe("terminal-1", (frame) => {
      frames.push(frame);
    }, { fromSeq: 0 });

    const replay = frames.find((frame) => frame.type === "pty.replay");
    assert.equal(replay?.baseSeq, 1);
    assert.equal(replay?.nextSeq, 3);
    assert.equal(replay?.droppedBeforeSeq, 1);
    assert.deepEqual(replay?.chunks, ["b", "c"]);
  });

  test("bounds replay by bytes and keeps the newest oversized chunk", () => {
    const hub = new PtyHub({ maxReplayChunks: 10, maxReplayBytes: 5 });
    hub.appendOutput("terminal-1", "aa");
    hub.appendOutput("terminal-1", "bbb");
    hub.appendOutput("terminal-1", "cccc");

    const frames: PtyServerFrame[] = [];
    const unsubscribe = hub.subscribe("terminal-1", (frame) => {
      frames.push(frame);
    }, { fromSeq: 0 });

    const replay = frames.find((frame) => frame.type === "pty.replay");
    assert.equal(replay?.baseSeq, 2);
    assert.equal(replay?.nextSeq, 3);
    assert.equal(replay?.droppedBeforeSeq, 2);
    assert.deepEqual(replay?.chunks, ["cccc"]);
    assert.deepEqual(hub.stats("terminal-1"), {
      sessionId: "terminal-1",
      replayChunks: 1,
      replayBytes: 4,
      maxReplayChunks: 10,
      maxReplayBytes: 5,
      nextSeq: 3,
      firstReplaySeq: 2,
      droppedBeforeSeq: 2,
      subscriberCount: 1,
      status: "open",
    });
    unsubscribe();
  });

  test("can replay only a bounded tail for late terminal viewers", () => {
    const hub = new PtyHub({ maxReplayChunks: 10, maxReplayBytes: 100 });
    hub.appendOutput("terminal-1", "aa");
    hub.appendOutput("terminal-1", "bbb");
    hub.appendOutput("terminal-1", "cccc");

    const frames: PtyServerFrame[] = [];
    const unsubscribe = hub.subscribe("terminal-1", (frame) => {
      frames.push(frame);
    }, { tailBytes: 5 });

    const replay = frames.find((frame) => frame.type === "pty.replay");
    assert.equal(replay?.baseSeq, 1);
    assert.equal(replay?.nextSeq, 3);
    assert.equal(replay?.droppedBeforeSeq, 1);
    assert.deepEqual(replay?.chunks, ["bbb", "cccc"]);

    unsubscribe();
  });

  test("can compact replay to the latest display snapshot while streaming every output", () => {
    const hub = new PtyHub({ maxReplayChunks: 10, maxReplayBytes: 100 });
    const liveFrames: PtyServerFrame[] = [];
    const unsubscribeLive = hub.subscribe("terminal-1", (frame) => {
      liveFrames.push(frame);
    });

    hub.appendOutput("terminal-1", "screen-a", { replaceReplay: true });
    hub.appendOutput("terminal-1", "screen-b", { replaceReplay: true });
    hub.appendOutput("terminal-1", "screen-c", { replaceReplay: true });

    assert.deepEqual(
      liveFrames
        .filter((frame) => frame.type === "pty.output")
        .map((frame) => frame.data),
      ["screen-a", "screen-b", "screen-c"],
    );

    const replayFrames: PtyServerFrame[] = [];
    const unsubscribeReplay = hub.subscribe("terminal-1", (frame) => {
      replayFrames.push(frame);
    });
    const replay = replayFrames.find((frame) => frame.type === "pty.replay");
    assert.equal(replay?.baseSeq, 2);
    assert.equal(replay?.nextSeq, 3);
    assert.equal(replay?.droppedBeforeSeq, 2);
    assert.deepEqual(replay?.chunks, ["screen-c"]);
    assert.equal(hub.stats("terminal-1")?.replayChunks, 1);

    unsubscribeLive();
    unsubscribeReplay();
  });

  test("can compact replay silently without sending a live replace frame", () => {
    const hub = new PtyHub({ maxReplayChunks: 10, maxReplayBytes: 100 });
    const liveFrames: PtyServerFrame[] = [];
    const unsubscribeLive = hub.subscribe("terminal-1", (frame) => {
      liveFrames.push(frame);
    });

    hub.appendOutput("terminal-1", "stream-a");
    hub.compactReplay("terminal-1", "screen-now");
    hub.appendOutput("terminal-1", "stream-b");

    assert.deepEqual(
      liveFrames
        .filter((frame) => frame.type === "pty.output")
        .map((frame) => frame.data),
      ["stream-a", "stream-b"],
    );
    assert.equal(
      liveFrames.some((frame) => frame.type === "pty.output" && frame.replace === true),
      false,
    );

    const replayFrames: PtyServerFrame[] = [];
    hub.subscribe("terminal-1", (frame) => {
      replayFrames.push(frame);
    });
    const replay = replayFrames.find((frame) => frame.type === "pty.replay");
    assert.equal(replay?.baseSeq, 1);
    assert.equal(replay?.nextSeq, 3);
    assert.deepEqual(replay?.chunks, ["screen-now", "stream-b"]);
    assert.equal(hub.stats("terminal-1")?.replayChunks, 2);

    unsubscribeLive();
  });

  test("reports PTY replay stats including subscribers and exit state", () => {
    const hub = new PtyHub({ maxReplayChunks: 3, maxReplayBytes: 100 });
    hub.ensureSession("terminal-1");
    const unsubscribe = hub.subscribe("terminal-1", () => undefined, false);
    hub.appendOutput("terminal-1", "ready");
    hub.emitExit("terminal-1", 0);

    assert.deepEqual(hub.stats("terminal-1"), {
      sessionId: "terminal-1",
      replayChunks: 1,
      replayBytes: 5,
      maxReplayChunks: 3,
      maxReplayBytes: 100,
      nextSeq: 2,
      firstReplaySeq: 0,
      subscriberCount: 1,
      status: "exited",
    });
    assert.equal(hub.listStats().length, 1);

    unsubscribe();
    assert.equal(hub.stats("terminal-1")?.subscriberCount, 0);
  });

  test("replays terminal exit state to late subscribers", () => {
    const hub = new PtyHub();
    hub.appendOutput("terminal-1", "ready");
    hub.emitExit("terminal-1", 0);
    hub.emitExit("terminal-1", 1);

    const frames: PtyServerFrame[] = [];
    hub.subscribe("terminal-1", (frame) => {
      frames.push(frame);
    });

    const replay = frames.find((frame) => frame.type === "pty.replay");
    const exit = frames.find((frame) => frame.type === "pty.exited");
    assert.equal(replay?.status, "exited");
    assert.equal(replay?.exitCode, 0);
    assert.equal(exit?.seq, 1);
    assert.equal(exit?.exitCode, 0);
  });

  test("can reset an exited session while preserving live subscribers", () => {
    const hub = new PtyHub();
    const frames: PtyServerFrame[] = [];
    const unsubscribe = hub.subscribe("terminal-1", (frame) => {
      frames.push(frame);
    });

    hub.appendOutput("terminal-1", "old");
    hub.emitExit("terminal-1", 0);
    hub.resetSession("terminal-1");
    hub.appendOutput("terminal-1", "new");

    assert.equal(hub.stats("terminal-1")?.status, "open");
    assert.equal(hub.stats("terminal-1")?.subscriberCount, 1);
    assert.equal(
      frames.some((frame) => frame.type === "pty.output" && frame.data === "new"),
      true,
    );

    const replayFrames: PtyServerFrame[] = [];
    hub.subscribe("terminal-1", (frame) => {
      replayFrames.push(frame);
    });
    const replay = replayFrames.find((frame) => frame.type === "pty.replay");
    assert.equal(replay?.status, "open");
    assert.deepEqual(replay?.chunks, ["new"]);
    assert.equal(replayFrames.some((frame) => frame.type === "pty.exited"), false);

    unsubscribe();
  });

  test("marks live frames that replace the replay buffer", () => {
    const hub = new PtyHub();
    const frames: PtyServerFrame[] = [];
    hub.subscribe("terminal-1", (frame) => {
      frames.push(frame);
    });

    hub.appendOutput("terminal-1", "snapshot", { replaceReplay: true });

    const output = frames.find((frame) => frame.type === "pty.output");
    assert.equal(output?.replace, true);

    const replayFrames: PtyServerFrame[] = [];
    hub.subscribe("terminal-1", (frame) => {
      replayFrames.push(frame);
    });
    const replay = replayFrames.find((frame) => frame.type === "pty.replay");
    assert.deepEqual(replay?.chunks, ["snapshot"]);
  });
});
