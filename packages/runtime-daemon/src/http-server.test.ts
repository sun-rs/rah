import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { WebSocket } from "ws";
import { RuntimeEngine } from "./runtime-engine";
import {
  readWebBuildId,
  startRahDaemon,
  type RahDaemon,
} from "./http-server";
import {
  MAX_JSON_BODY_BYTES,
  readJsonBody,
  requestErrorStatus,
} from "./http-server-response";
import {
  parseAttachSessionRequest,
  parseCreateCouncilRequest,
  parsePermissionResponseRequest,
  parseResumeSessionRequest,
  parseSessionInputRequest,
  parseSetSessionModelRequest,
  parseStartSessionRequest,
  parseStoredSessionArchiveRequest,
} from "./http-server-request-validation";
import { isLoopbackRemoteAddress, sendJsonWithBackpressure } from "./http-server-websocket";
import {
  isLocalMachineRemoteAddress,
  isLocalNetworkRemoteAddress,
  resolveImagePreviewModeForPeer,
} from "./http-server-client-address";
import { SessionInputQueueConflictError } from "./session-input-queue";
import { turnArtifactOwnerKey } from "./turn-artifact-store";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate free port."));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function requestJson(args: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`http://127.0.0.1:${args.port}${args.path}`, {
    method: args.method ?? "GET",
    headers: {
      ...(args.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(args.headers ?? {}),
    },
    ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
  });
  return {
    status: response.status,
    json: await response.json(),
  };
}

async function openWebSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  return await new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out opening websocket ${url}`));
    }, 1_000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitFor(predicate: () => void, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      predicate();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error("Timed out waiting for condition.");
}

test("reads the exact Web build generation published beside the assets", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-web-build-id-"));
  try {
    const dist = path.join(root, "packages", "client-web", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      path.join(dist, ".rah-web-build.json"),
      JSON.stringify({ version: 1, webBuildId: "generation-123" }),
      "utf8",
    );
    assert.equal(readWebBuildId(root), "generation-123");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("startRahDaemon", () => {
  let tempHome: string;
  let previousRahHome: string | undefined;
  let daemon: RahDaemon | null = null;
  let engine: RuntimeEngine;
  let port: number;

  beforeEach(async () => {
    previousRahHome = process.env.RAH_HOME;
    tempHome = mkdtempSync(path.join(os.tmpdir(), "rah-http-server-"));
    process.env.RAH_HOME = tempHome;
    port = await freePort();
    engine = new RuntimeEngine();
    daemon = await startRahDaemon({
      port,
      engine,
      auth: false,
    });
  });

  afterEach(async () => {
    await daemon?.close();
    daemon = null;
    if (previousRahHome === undefined) {
      delete process.env.RAH_HOME;
    } else {
      process.env.RAH_HOME = previousRahHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("rejects cross-origin API requests", async () => {
    const response = await requestJson({
      port,
      path: "/api/sessions",
      headers: { Origin: "http://evil.example" },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(response.json, { error: "Cross-origin requests are not allowed." });
  });

  test("requires x-rah-client for same-origin POST requests", async () => {
    const response = await requestJson({
      port,
      path: "/api/workspaces/select",
      method: "POST",
      headers: { Origin: `http://127.0.0.1:${port}` },
      body: { dir: tempHome },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(response.json, { error: "Missing required RAH client header." });
  });

  test("accepts same-origin POST requests with x-rah-client", async () => {
    const response = await requestJson({
      port,
      path: "/api/workspaces/select",
      method: "POST",
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        "x-rah-client": "web",
      },
      body: { dir: tempHome },
    });
    assert.equal(response.status, 200);
    assert.equal(typeof response.json, "object");
  });

  test("uploads device files as opaque daemon-owned attachments", async () => {
    const pixelPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lz7c7wAAAABJRU5ErkJggg==",
      "base64",
    );
    const response = await fetch(`http://127.0.0.1:${port}/api/attachments`, {
      method: "POST",
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        "content-type": "image/png",
        "x-rah-client": "web",
        "x-rah-file-name": encodeURIComponent("phone photo.png"),
      },
      body: pixelPng,
    });

    assert.equal(response.status, 201);
    const json = await response.json() as {
      attachment?: Record<string, unknown>;
    };
    assert.equal(json.attachment?.kind, "image");
    assert.equal(json.attachment?.name, "phone photo.png");
    assert.equal(json.attachment?.mediaType, "image/png");
    assert.equal(json.attachment?.size, pixelPng.byteLength);
    assert.equal(typeof json.attachment?.id, "string");
    assert.equal("path" in (json.attachment ?? {}), false);

    const attachmentId = String(json.attachment?.id);
    const preview = await requestJson({
      port,
      path: `/api/attachments/${encodeURIComponent(attachmentId)}?imagePreviewClient=local`,
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(preview.status, 200);
    const previewJson = preview.json as {
      attachment?: Record<string, unknown>;
      file?: Record<string, unknown>;
    };
    assert.equal(previewJson.attachment?.id, attachmentId);
    assert.equal(previewJson.attachment?.name, "phone photo.png");
    assert.equal("path" in (previewJson.attachment ?? {}), false);
    assert.equal(previewJson.file?.mimeType, "image/png");
    assert.equal(previewJson.file?.contentBase64, pixelPng.toString("base64"));
    assert.equal(typeof previewJson.file?.path, "string");
  });

  test("serves runtime identity", async () => {
    const response = await requestJson({
      port,
      path: "/api/runtime",
      headers: { Origin: `http://127.0.0.1:${port}` },
    });

    assert.equal(response.status, 200);
    assert.equal(typeof response.json, "object");
    assert.ok(response.json && !Array.isArray(response.json));
    const identity = response.json as Record<string, unknown>;
    assert.equal(identity.name, "rah");
    assert.equal(identity.pid, process.pid);
    assert.equal(identity.port, port);
    assert.equal(identity.rootDir, process.cwd());
    assert.equal(typeof identity.runtimeId, "string");
    assert.equal(typeof identity.startedAt, "string");
  });

  test("shares runtime compatibility mute state across clients", async () => {
    const origin = `http://127.0.0.1:${port}`;
    const before = await requestJson({
      port,
      path: "/api/workbench/notices/runtime-compatibility",
      headers: { Origin: origin },
    });
    assert.equal(before.status, 200);
    assert.deepEqual(before.json, {});

    const muted = await requestJson({
      port,
      path: "/api/workbench/notices/runtime-compatibility/mute",
      method: "PUT",
      headers: { Origin: origin, "x-rah-client": "web" },
    });
    assert.equal(muted.status, 200);
    const mutedUntil = (muted.json as { mutedUntil?: unknown }).mutedUntil;
    assert.equal(typeof mutedUntil, "string");
    assert.ok(Date.parse(mutedUntil as string) > Date.now());

    const otherClient = await requestJson({
      port,
      path: "/api/workbench/notices/runtime-compatibility",
      headers: { Origin: origin },
    });
    assert.deepEqual(otherClient.json, { mutedUntil });
  });

  test("serves the provider-neutral conversation turn projection", async () => {
    const state = engine.sessionStore.createManagedSession({
      provider: "custom",
      launchSource: "web",
      cwd: tempHome,
      rootDir: tempHome,
    });
    const source = {
      provider: "custom" as const,
      channel: "structured_live" as const,
      authority: "authoritative" as const,
    };
    engine.eventBus.publish({
      sessionId: state.session.id,
      turnId: "turn-1",
      type: "turn.started",
      source,
      payload: {},
    });
    engine.eventBus.publish({
      sessionId: state.session.id,
      turnId: "turn-1",
      type: "timeline.item.added",
      source,
      payload: {
        item: {
          kind: "assistant_message",
          text: "Conversation is ready.",
          phase: "final_answer",
          messageId: "assistant-1",
        },
      },
    });
    engine.eventBus.publish({
      sessionId: state.session.id,
      turnId: "turn-1",
      type: "observation.completed",
      source,
      payload: {
        observation: {
          id: "observation-1",
          kind: "command.run",
          status: "completed",
          title: "Run command",
          subject: { providerCallId: "call-1" },
          detail: {
            artifacts: [{ kind: "text", label: "Output", text: "complete output" }],
          },
        },
      },
    });
    engine.eventBus.publish({
      sessionId: state.session.id,
      turnId: "turn-1",
      type: "turn.completed",
      source,
      payload: {},
    });

    const response = await requestJson({
      port,
      path: `/api/sessions/${state.session.id}/conversation/turns?limit=10`,
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(response.status, 200);
    assert.ok(response.json && typeof response.json === "object" && !Array.isArray(response.json));
    const body = response.json as Record<string, unknown>;
    assert.equal(body.sessionId, state.session.id);
    assert.equal(body.sourceEventCount, 4);
    assert.equal(typeof body.approximateBytes, "number");
    assert.ok(Array.isArray(body.turns));
    const turn = body.turns[0] as Record<string, unknown>;
    assert.equal(turn.status, "completed");
    assert.equal(typeof turn.finalAnswerItemId, "string");
    const items = turn.items as Array<Record<string, unknown>>;
    const observation = items.find(
      (item) => (item.content as Record<string, unknown>)?.kind === "observation",
    );
    assert.ok(observation);
    const providerItemId = observation.providerItemId as string;
    const detailResponse = await requestJson({
      port,
      path:
        `/api/sessions/${state.session.id}/conversation/items/${encodeURIComponent(observation.id as string)}/detail` +
        `?providerTurnId=turn-1&providerItemId=${encodeURIComponent(providerItemId)}`,
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(detailResponse.status, 200);
    const detailBody = detailResponse.json as Record<string, unknown>;
    const detailedItem = detailBody.item as Record<string, unknown>;
    const detailedContent = detailedItem.content as Record<string, unknown>;
    const detailedObservation = detailedContent.observation as Record<string, unknown>;
    assert.equal(
      ((detailedObservation.detail as Record<string, unknown>).artifacts as Array<Record<string, unknown>>)[0]?.text,
      "complete output",
    );

    const liveOnlyResponse = await requestJson({
      port,
      path: `/api/sessions/${state.session.id}/conversation/turns?limit=10&liveOnly=true`,
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(liveOnlyResponse.status, 200);
    const liveOnlyBody = liveOnlyResponse.json as Record<string, unknown>;
    assert.equal(liveOnlyBody.sessionId, state.session.id);
    assert.ok(Array.isArray(liveOnlyBody.turns));
    assert.equal((liveOnlyBody.turns as unknown[]).length, 1);

    const resourceIndexResponse = await requestJson({
      port,
      path: `/api/sessions/${state.session.id}/conversation/resources`,
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(resourceIndexResponse.status, 200);
    const resourceIndexBody = resourceIndexResponse.json as Record<string, unknown>;
    assert.equal(resourceIndexBody.sessionId, state.session.id);
    assert.equal(typeof resourceIndexBody.sourceRevision, "string");
    assert.equal(typeof resourceIndexBody.complete, "boolean");
    assert.ok(Array.isArray(resourceIndexBody.outputs));
    assert.ok(Array.isArray(resourceIndexBody.sources));
  });

  test("serves an isolated provider-native conversation visual document", async () => {
    engine.getSessionConversationVisualArtifact = async (
      sessionId,
      artifactId,
    ) => {
      assert.equal(sessionId, "visual-session");
      assert.equal(artifactId, "equity-curve.html");
      return {
        id: artifactId,
        format: "interactive_html",
        mimeType: "text/html",
        fragment: '<main id="equity-curve">Interactive chart</main>',
      };
    };

    const response = await fetch(
      `http://127.0.0.1:${port}/api/sessions/visual-session/conversation/visual-artifacts/equity-curve.html?theme=dark`,
      {
        headers: { Origin: `http://127.0.0.1:${port}` },
      },
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(
      response.headers.get("content-security-policy") ?? "",
      /default-src 'none'/,
    );
    const document = await response.text();
    assert.match(document, /^<!doctype html>/);
    assert.match(document, /<html lang="en" data-theme="dark">/);
    assert.match(document, /id="equity-curve"/);
    assert.match(document, /rah\.visual\.resize/);
  });

  test("returns a daemon-resolved conversation visual source for file preview", async () => {
    engine.getSessionConversationVisualArtifactSource = async (
      sessionId,
      artifactId,
    ) => {
      assert.equal(sessionId, "visual-session");
      assert.equal(artifactId, "equity-curve.html");
      return {
        sessionId,
        artifactId,
        path: "/workspace/.codex/visualizations/equity-curve.html",
      };
    };

    const response = await requestJson({
      port,
      path: "/api/sessions/visual-session/conversation/visual-artifacts/equity-curve.html/source",
      headers: { Origin: `http://127.0.0.1:${port}` },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.json, {
      sessionId: "visual-session",
      artifactId: "equity-curve.html",
      path: "/workspace/.codex/visualizations/equity-curve.html",
    });
  });

  test("streams canonical conversation deltas with live events", async () => {
    const state = engine.sessionStore.createManagedSession({
      provider: "custom",
      launchSource: "web",
      cwd: tempHome,
      rootDir: tempHome,
    });
    const socket = await openWebSocket(`ws://127.0.0.1:${port}/api/events`);
    const batchPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for a conversation delta."));
      }, 1_000);
      socket.on("message", (raw) => {
        const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        if (!Array.isArray(parsed.conversationDeltas)) {
          return;
        }
        clearTimeout(timer);
        resolve(parsed);
      });
    });
    const published = engine.eventBus.publish({
      sessionId: state.session.id,
      turnId: "turn-live",
      type: "turn.started",
      source: {
        provider: "custom",
        channel: "structured_live",
        authority: "authoritative",
      },
      payload: {},
    });

    const batch = await batchPromise;
    socket.close();
    assert.ok(Array.isArray(batch.events));
    const streamedEvent = batch.events[0] as Record<string, unknown>;
    assert.equal(streamedEvent.seq, published.seq);
    const streamedDelta = (batch.conversationDeltas as Array<Record<string, unknown>>)[0];
    assert.equal(streamedDelta?.sessionId, state.session.id);
    assert.equal(streamedDelta?.sourceSeq, published.seq);
    assert.equal(streamedDelta?.baseRevision, 0);
    assert.equal(streamedDelta?.revision, 1);
  });

  test("filters the initial event replay before the websocket subscription frame", async () => {
    const target = engine.eventBus.publish({
      sessionId: "target-session",
      turnId: "target-turn",
      type: "turn.started",
      source: {
        provider: "custom",
        channel: "structured_live",
        authority: "authoritative",
      },
      payload: {},
    });
    engine.eventBus.publish({
      sessionId: "other-session",
      turnId: "other-turn",
      type: "turn.started",
      source: {
        provider: "custom",
        channel: "structured_live",
        authority: "authoritative",
      },
      payload: {},
    });

    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/api/events?sessionId=target-session&eventType=turn.started`,
    );
    const batch = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Timed out waiting for filtered initial replay."));
      }, 1_000);
      socket.once("message", (raw) => {
        clearTimeout(timer);
        resolve(JSON.parse(raw.toString("utf8")) as Record<string, unknown>);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    socket.close();

    assert.equal(batch.initial, true);
    const events = batch.events as Array<Record<string, unknown>>;
    assert.deepEqual(events.map((event) => event.seq), [target.seq]);
  });

  test("acknowledges an empty initial event replay", async () => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/api/events?sessionId=no-events-for-this-session`,
    );
    const batch = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Timed out waiting for empty initial replay acknowledgement."));
      }, 1_000);
      socket.once("message", (raw) => {
        clearTimeout(timer);
        resolve(JSON.parse(raw.toString("utf8")) as Record<string, unknown>);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    socket.close();

    assert.equal(batch.initial, true);
    assert.deepEqual(batch.events, []);
  });

  test("can subscribe to live filtered events without replaying retained history", async () => {
    engine.eventBus.publish({
      sessionId: "council-1",
      type: "council.message.created",
      source: {
        provider: "system",
        channel: "system",
        authority: "authoritative",
      },
      payload: {
        council: {
          id: "council-1",
          title: "Council 1",
          workspace: tempHome,
          status: "running",
          phase: "ready",
          agents: [],
          createdAt: "2026-07-14T00:00:00.000Z",
          updatedAt: "2026-07-14T00:00:00.000Z",
        },
        message: {
          id: 1,
          councilId: "council-1",
          actorId: "agent-1",
          role: "agent",
          parts: [{ kind: "text", text: "retained" }],
          createdAt: "2026-07-14T00:00:00.000Z",
        },
      },
    });

    const socket = await openWebSocket(
      `ws://127.0.0.1:${port}/api/events?eventType=council.message.created&initialReplay=false`,
    );
    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for live event.")), 1_000);
      socket.once("message", (raw) => {
        clearTimeout(timer);
        resolve(JSON.parse(raw.toString("utf8")) as Record<string, unknown>);
      });
    });
    const live = engine.eventBus.publish({
      sessionId: "council-1",
      turnId: "live-turn",
      type: "turn.started",
      source: {
        provider: "custom",
        channel: "structured_live",
        authority: "authoritative",
      },
      payload: {},
    });
    engine.eventBus.publish({
      sessionId: "council-1",
      type: "council.message.created",
      source: {
        provider: "system",
        channel: "system",
        authority: "authoritative",
      },
      payload: {
        council: {
          id: "council-1",
          title: "Council 1",
          workspace: tempHome,
          status: "running",
          phase: "ready",
          agents: [],
          createdAt: "2026-07-14T00:00:00.000Z",
          updatedAt: "2026-07-14T00:01:00.000Z",
        },
        message: {
          id: 2,
          councilId: "council-1",
          actorId: "agent-1",
          role: "agent",
          parts: [{ kind: "text", text: "live" }],
          createdAt: "2026-07-14T00:01:00.000Z",
        },
      },
    });

    const batch = await received;
    socket.close();
    assert.equal(batch.initial, undefined);
    const events = batch.events as Array<Record<string, unknown>>;
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "council.message.created");
    assert.notEqual(events[0]?.seq, live.seq);
  });

  test("closes promptly while an event websocket is still connected", async () => {
    const socket = await openWebSocket(`ws://127.0.0.1:${port}/api/events`);
    const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const startedAt = Date.now();
    let timeout: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        daemon!.close(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Daemon close waited on its own websocket client.")),
            3_000,
          );
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
    daemon = null;

    await socketClosed;
    assert.ok(Date.now() - startedAt < 3_000);
  });

  test("starts cleanup immediately and bounds draining for a stalled HTTP request", async () => {
    await daemon!.close();
    daemon = null;

    port = await freePort();
    engine = new RuntimeEngine();
    let notifyShutdownStarted: (() => void) | undefined;
    const shutdownStarted = new Promise<void>((resolve) => {
      notifyShutdownStarted = resolve;
    });
    const originalShutdown = engine.shutdown.bind(engine);
    engine.shutdown = async () => {
      notifyShutdownStarted?.();
      await originalShutdown();
    };
    daemon = await startRahDaemon({
      port,
      engine,
      auth: false,
      httpDrainTimeoutMs: 25,
    });

    let notifySocketAssigned: (() => void) | undefined;
    const socketAssigned = new Promise<void>((resolve) => {
      notifySocketAssigned = resolve;
    });
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/api/sessions/start",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "100",
      },
    });
    request.on("error", () => undefined);
    request.once("socket", (socket) => {
      if (socket.readyState === "open") {
        notifySocketAssigned?.();
      } else {
        socket.once("connect", () => notifySocketAssigned?.());
      }
    });
    request.write("{");
    await socketAssigned;

    const startedAt = Date.now();
    let shutdownTimeout: NodeJS.Timeout | undefined;
    try {
      await Promise.all([
        daemon.close(),
        Promise.race([
          shutdownStarted,
          new Promise<never>((_resolve, reject) => {
            shutdownTimeout = setTimeout(
              () => reject(new Error("Engine cleanup did not start promptly.")),
              500,
            );
          }),
        ]),
      ]);
    } finally {
      if (shutdownTimeout) {
        clearTimeout(shutdownTimeout);
      }
    }
    daemon = null;
    request.destroy();

    assert.ok(Date.now() - startedAt < 1_000);
  });

  test("serves native TUI diagnostics", async () => {
    const response = await requestJson({
      port,
      path: "/api/native-tui/diagnostics",
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { diagnostics: [] });
  });

  test("serves PTY replay stats", async () => {
    engine.ptyHub.appendOutput("terminal-1", "ready");
    const response = await requestJson({
      port,
      path: "/api/pty/stats",
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, {
      sessions: [
        {
          sessionId: "terminal-1",
          replayChunks: 1,
          replayBytes: 5,
          maxReplayChunks: 2000,
          maxReplayBytes: 8388608,
          nextSeq: 1,
          firstReplaySeq: 0,
          subscriberCount: 0,
          status: "open",
        },
      ],
    });
  });

  test("rejects closing non-RAH TUI mux sessions", async () => {
    const response = await requestJson({
      port,
      path: "/api/tui-mux/sessions/user-session/close",
      method: "POST",
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        "x-rah-client": "web",
      },
      body: {},
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.json, {
      error: "Only RAH-owned TUI mux sessions can be closed from diagnostics.",
    });
  });

  test("PTY websocket input is bound to the URL session rather than payload sessionId", async () => {
    const first = await engine.startIndependentTerminal({ cwd: tempHome, cols: 80, rows: 24 });
    const second = await engine.startIndependentTerminal({ cwd: tempHome, cols: 80, rows: 24 });
    let firstTranscript = "";
    let secondTranscript = "";
    const unsubscribeFirst = engine.ptyHub.subscribe(first.terminal.id, (frame) => {
      if (frame.type === "pty.output") {
        firstTranscript += frame.data;
      } else if (frame.type === "pty.replay") {
        firstTranscript += frame.chunks.join("");
      }
    });
    const unsubscribeSecond = engine.ptyHub.subscribe(second.terminal.id, (frame) => {
      if (frame.type === "pty.output") {
        secondTranscript += frame.data;
      } else if (frame.type === "pty.replay") {
        secondTranscript += frame.chunks.join("");
      }
    });
    const socket = await openWebSocket(`ws://127.0.0.1:${port}/api/pty/${first.terminal.id}`);
    try {
      socket.send(
        JSON.stringify({
          type: "pty.input",
          sessionId: second.terminal.id,
          clientId: "web-user",
          data: "printf 'RAH_URL_BOUND\\n'\r",
        }),
      );
      await waitFor(() => {
        assert.match(firstTranscript, /RAH_URL_BOUND/);
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.doesNotMatch(secondTranscript, /RAH_URL_BOUND/);
    } finally {
      socket.close();
      unsubscribeFirst();
      unsubscribeSecond();
      await engine.closeIndependentTerminal(first.terminal.id);
      await engine.closeIndependentTerminal(second.terminal.id);
    }
  });

  test("PTY websocket heartbeat replies without reaching terminal stdin", async () => {
    const terminal = await engine.startIndependentTerminal({ cwd: tempHome, cols: 80, rows: 24 });
    let transcript = "";
    const unsubscribe = engine.ptyHub.subscribe(terminal.terminal.id, (frame) => {
      if (frame.type === "pty.output") {
        transcript += frame.data;
      } else if (frame.type === "pty.replay") {
        transcript += frame.chunks.join("");
      }
    });
    const socket = await openWebSocket(`ws://127.0.0.1:${port}/api/pty/${terminal.terminal.id}`);
    try {
      const pong = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for PTY pong")), 1_000);
        socket.on("message", (raw) => {
          const parsed = JSON.parse(raw.toString("utf8")) as { type?: string };
          if (parsed.type === "pty.server.pong") {
            clearTimeout(timer);
            resolve(parsed);
          }
        });
      });
      socket.send(
        JSON.stringify({
          type: "pty.client.ping",
          sessionId: "payload-session-ignored",
          clientId: "web-user",
          nonce: "heartbeat-1",
        }),
      );
      assert.deepEqual(await pong, {
        type: "pty.server.pong",
        sessionId: terminal.terminal.id,
        nonce: "heartbeat-1",
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.doesNotMatch(transcript, /heartbeat-1/);
    } finally {
      socket.close();
      unsubscribe();
      await engine.closeIndependentTerminal(terminal.terminal.id);
    }
  });

  test("lists independent terminals so hidden dialogs can reattach", async () => {
    const first = await engine.startIndependentTerminal({
      cwd: tempHome,
      cols: 80,
      rows: 24,
      owner: { kind: "session", id: "session-a" },
    });
    const second = await engine.startIndependentTerminal({
      cwd: tempHome,
      cols: 80,
      rows: 24,
      owner: { kind: "session", id: "session-b" },
    });
    try {
      const response = await requestJson({
        port,
        path: `/api/terminal/list?cwd=${encodeURIComponent(tempHome)}`,
        headers: {
          Origin: `http://127.0.0.1:${port}`,
          "x-rah-client": "web",
        },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(response.json, {
        terminals: [first.terminal, second.terminal].sort((a, b) => a.id.localeCompare(b.id)),
      });
      const scopedResponse = await requestJson({
        port,
        path: `/api/terminal/list?cwd=${encodeURIComponent(tempHome)}&ownerKind=session&ownerId=session-a`,
        headers: {
          Origin: `http://127.0.0.1:${port}`,
          "x-rah-client": "web",
        },
      });
      assert.equal(scopedResponse.status, 200);
      assert.deepEqual(scopedResponse.json, {
        terminals: [first.terminal],
      });
    } finally {
      await engine.closeIndependentTerminal(first.terminal.id);
      await engine.closeIndependentTerminal(second.terminal.id);
    }
  });

  test("rejects provider control live backend at the public HTTP boundary", async () => {
    const start = await requestJson({
      port,
      path: "/api/sessions/start",
      method: "POST",
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        "x-rah-client": "web",
      },
      body: {
        provider: "codex",
        cwd: tempHome,
        liveBackend: "structured",
      },
    });
    assert.equal(start.status, 400);
    assert.deepEqual(start.json, { error: "Bad Request: liveBackend is invalid." });

    const resume = await requestJson({
      port,
      path: "/api/sessions/resume",
      method: "POST",
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        "x-rah-client": "web",
      },
      body: {
        provider: "codex",
        providerSessionId: "thread-provider-control",
        cwd: tempHome,
        liveBackend: "structured",
      },
    });
    assert.equal(resume.status, 400);
    assert.deepEqual(resume.json, { error: "Bad Request: liveBackend is invalid." });
  });

  test("accepts native local server live backend at the public HTTP boundary", () => {
    const start = parseStartSessionRequest({
      provider: "codex",
      cwd: tempHome,
      liveBackend: "native_local_server",
    });
    assert.equal(start.liveBackend, "native_local_server");

    const resume = parseResumeSessionRequest({
      provider: "opencode",
      providerSessionId: "session-native-local-server",
      cwd: tempHome,
      liveBackend: "native_local_server",
    });
    assert.equal(resume.liveBackend, "native_local_server");
  });

  test("validates atomic running-session archive identity fields together", () => {
    assert.deepEqual(
      parseStoredSessionArchiveRequest({
        provider: "codex",
        providerSessionId: "thread-1",
        runtimeSessionId: "runtime-1",
        clientId: "client-1",
      }),
      {
        provider: "codex",
        providerSessionId: "thread-1",
        runtimeSessionId: "runtime-1",
        clientId: "client-1",
      },
    );
    assert.throws(
      () =>
        parseStoredSessionArchiveRequest({
          provider: "codex",
          providerSessionId: "thread-1",
          runtimeSessionId: "runtime-1",
        }),
      /must be provided together/,
    );
  });

  test("accepts attachment-only session input and rejects duplicate attachment ids", () => {
    const attachment = {
      id: "00000000-0000-4000-8000-000000000001",
      kind: "image" as const,
      name: "photo.png",
      mediaType: "image/png",
      size: 10,
    };
    assert.deepEqual(
      parseSessionInputRequest({
        clientId: "client-1",
        text: "",
        attachments: [attachment],
      }),
      {
        clientId: "client-1",
        text: "",
        attachments: [attachment],
      },
    );
    assert.throws(
      () => parseSessionInputRequest({
        clientId: "client-1",
        text: "",
        attachments: [attachment, attachment],
      }),
      /duplicate attachment ids/,
    );
  });

  test("accepts structured response annotations and rejects duplicate annotation ids", () => {
    const annotation = {
      id: "annotation-1",
      text: "Selected assistant text",
      source: {
        sessionId: "session-1",
        entryKey: "assistant-1",
        role: "assistant" as const,
      },
    };
    assert.deepEqual(
      parseSessionInputRequest({
        clientId: "client-1",
        text: "Explain this.",
        annotations: [annotation],
      }),
      {
        clientId: "client-1",
        text: "Explain this.",
        annotations: [annotation],
      },
    );
    assert.throws(
      () => parseSessionInputRequest({
        clientId: "client-1",
        text: "Explain this.",
        annotations: [annotation, annotation],
      }),
      /duplicate annotation ids/,
    );
    assert.throws(
      () => parseSessionInputRequest({
        clientId: "client-1",
        text: "Explain this.",
        annotations: [{ ...annotation, annotation: "x".repeat(20_001) }],
      }),
      /annotation is too long/,
    );
  });

  test("parses the complete first input inside start and live-resume requests", () => {
    const initialInput = {
      clientId: "web-client",
      clientMessageId: "client-message:first",
      clientTurnId: "client-turn:first",
      text: "Continue the large Session",
      attachments: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          kind: "image" as const,
          name: "evidence.png",
          mediaType: "image/png",
          size: 42,
        },
      ],
      annotations: [
        {
          id: "annotation-first",
          text: "Earlier context",
          source: {
            sessionId: "history-session",
            entryKey: "assistant-entry",
            role: "assistant" as const,
          },
        },
      ],
    };

    assert.deepEqual(
      parseStartSessionRequest({
        provider: "codex",
        cwd: tempHome,
        initialInput,
      }).initialInput,
      initialInput,
    );
    assert.deepEqual(
      parseResumeSessionRequest({
        provider: "codex",
        providerSessionId: "thread-large-history",
        initialInput,
      }).initialInput,
      initialInput,
    );
    assert.deepEqual(
      parseAttachSessionRequest({
        client: {
          id: "web-client",
          kind: "web",
          connectionId: "web-connection",
        },
        mode: "interactive",
        claimControl: true,
        model: "gpt-5.6-sol",
        optionValues: { model_reasoning_effort: "medium" },
        modeId: "plan",
        initialInput,
      }),
      {
        client: {
          id: "web-client",
          kind: "web",
          connectionId: "web-connection",
        },
        mode: "interactive",
        claimControl: true,
        model: "gpt-5.6-sol",
        optionValues: { model_reasoning_effort: "medium" },
        modeId: "plan",
        initialInput,
      },
    );
  });

  test("rejects removed model and access aliases at the public HTTP boundary", () => {
    assert.throws(
      () =>
        parseStartSessionRequest({
          provider: "codex",
          cwd: tempHome,
          reasoningId: "xhigh",
        }),
      /reasoningId was removed/,
    );
    assert.throws(
      () =>
        parseResumeSessionRequest({
          provider: "codex",
          providerSessionId: "thread-1",
          approvalPolicy: "never",
        }),
      /approvalPolicy was removed/,
    );
    assert.throws(
      () => parseSetSessionModelRequest({ modelId: "gpt-5.5", reasoningId: "xhigh" }),
      /reasoningId was removed/,
    );
    assert.throws(
      () =>
        parseCreateCouncilRequest({
          workspace: tempHome,
          agents: [
            {
              provider: "codex",
              label: "reviewer",
              reasoningId: "xhigh",
            },
          ],
        }),
      /reasoningId was removed/,
    );
  });

  test("keeps provider-native permission decisions behind the adapter boundary", () => {
    assert.deepEqual(
      parsePermissionResponseRequest({
        behavior: "allow",
        decision: "approved_for_session",
      }),
      {
        behavior: "allow",
        decision: "approved_for_session",
      },
    );
    assert.throws(
      () =>
        parsePermissionResponseRequest({
          behavior: "allow",
          decision: "acceptForSession",
        }),
      /decision is invalid/,
    );
  });

  test("rejects unsupported live providers at the public HTTP boundary", async () => {
    const start = await requestJson({
      port,
      path: "/api/sessions/start",
      method: "POST",
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        "x-rah-client": "web",
      },
      body: {
        provider: "custom",
        cwd: tempHome,
      },
    });
    assert.equal(start.status, 400);
    assert.deepEqual(start.json, {
      error: "Provider custom is not a supported live provider. Use Codex, Claude, or OpenCode.",
    });

    const resume = await requestJson({
      port,
      path: "/api/sessions/resume",
      method: "POST",
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        "x-rah-client": "web",
      },
      body: {
        provider: "custom",
        providerSessionId: "custom-session",
        cwd: tempHome,
      },
    });
    assert.equal(resume.status, 400);
    assert.deepEqual(resume.json, {
      error: "Provider custom is not a supported live provider. Use Codex, Claude, or OpenCode.",
    });
  });

  test("rejects oversized JSON request bodies before buffering them", async () => {
    const request = Readable.from([]) as unknown as IncomingMessage;
    Object.defineProperty(request, "headers", {
      value: { "content-length": String(MAX_JSON_BODY_BYTES + 1) },
    });

    await assert.rejects(readJsonBody(request), /Request body too large/);
  });

  test("maps malformed JSON request bodies to bad request", async () => {
    const request = Readable.from(["{"]) as unknown as IncomingMessage;
    Object.defineProperty(request, "headers", {
      value: {},
    });

    await assert.rejects(readJsonBody(request), /Bad Request: invalid JSON body/);
  });

  test("maps known request errors to client-facing HTTP statuses", () => {
    assert.equal(
      requestErrorStatus(
        new Error("Requested workspace scope is outside the session workspace boundary."),
      ),
      403,
    );
    assert.equal(
      requestErrorStatus(new Error("Cannot remove a workspace with active running sessions.")),
      400,
    );
    assert.equal(
      requestErrorStatus(new Error("Provider custom is not a supported live provider.")),
      400,
    );
    assert.equal(
      requestErrorStatus(new Error("Bad Request: invalid JSON body.")),
      400,
    );
    assert.equal(
      requestErrorStatus(
        new SessionInputQueueConflictError(
          "Queued message is no longer waiting and cannot be edited.",
        ),
      ),
      409,
    );
    assert.equal(requestErrorStatus(new Error("Queued message cannot be empty.")), 400);
  });

  test("recognizes loopback clients for host-only websocket fallbacks", () => {
    assert.equal(isLoopbackRemoteAddress("127.0.0.1"), true);
    assert.equal(isLoopbackRemoteAddress("::1"), true);
    assert.equal(isLoopbackRemoteAddress("::ffff:127.0.0.1"), true);
    assert.equal(isLoopbackRemoteAddress("192.168.1.20"), false);
    assert.equal(isLoopbackRemoteAddress(undefined), false);
  });

  test("recognizes same-machine LAN clients for host-only fallbacks", () => {
    assert.equal(isLocalMachineRemoteAddress("127.0.0.1"), true);
    assert.equal(isLocalMachineRemoteAddress("::ffff:127.0.0.1"), true);
    assert.equal(isLocalMachineRemoteAddress("203.0.113.10"), false);
    assert.equal(isLocalMachineRemoteAddress(undefined), false);
  });

  test("distinguishes direct LAN peers from Tailscale and public peers", () => {
    assert.equal(isLocalNetworkRemoteAddress("127.0.0.1"), true);
    assert.equal(isLocalNetworkRemoteAddress("::ffff:192.168.1.20"), true);
    assert.equal(isLocalNetworkRemoteAddress("10.0.0.8"), true);
    assert.equal(isLocalNetworkRemoteAddress("172.20.4.2"), true);
    assert.equal(isLocalNetworkRemoteAddress("100.64.0.9"), false);
    assert.equal(isLocalNetworkRemoteAddress("203.0.113.10"), false);
  });

  test("allows full image previews only for direct local-network requests", () => {
    assert.equal(
      resolveImagePreviewModeForPeer({
        hostname: "192.168.1.86",
        remoteAddress: "192.168.1.20",
        clientHint: "local",
      }),
      "full",
    );
    assert.equal(
      resolveImagePreviewModeForPeer({
        hostname: "100.64.0.8",
        remoteAddress: "100.64.0.9",
        clientHint: "local",
      }),
      "bounded",
    );
    assert.equal(
      resolveImagePreviewModeForPeer({
        hostname: "192.168.1.86",
        remoteAddress: "100.64.0.9",
        clientHint: "local",
      }),
      "bounded",
    );
    assert.equal(
      resolveImagePreviewModeForPeer({
        hostname: "127.0.0.1",
        remoteAddress: "127.0.0.1",
        clientHint: "remote",
      }),
      "bounded",
    );
  });

  test("sends websocket JSON while under the backpressure threshold", () => {
    const sent: string[] = [];
    const socket = {
      readyState: 1,
      bufferedAmount: 3,
      send: (data: string) => {
        sent.push(data);
      },
      close: () => {
        throw new Error("close should not be called");
      },
    };

    assert.equal(
      sendJsonWithBackpressure(socket, { ok: true }, { maxBufferedBytes: 4 }),
      true,
    );
    assert.deepEqual(sent, ['{"ok":true}']);
  });

  test("closes slow websocket clients before adding more buffered data", () => {
    const closeCalls: Array<{ code?: number; reason?: string }> = [];
    const socket = {
      readyState: 1,
      bufferedAmount: 5,
      send: () => {
        throw new Error("send should not be called");
      },
      close: (code?: number, reason?: string) => {
        closeCalls.push({
          ...(code !== undefined ? { code } : {}),
          ...(reason !== undefined ? { reason } : {}),
        });
      },
    };

    assert.equal(
      sendJsonWithBackpressure(socket, { ok: true }, {
        maxBufferedBytes: 4,
        closeReason: "test slow client",
      }),
      false,
    );
    assert.deepEqual(closeCalls, [{ code: 1013, reason: "test slow client" }]);
  });

  test("rejects oversized websocket messages before JSON serialization and send", () => {
    const closeCalls: Array<{ code?: number; reason?: string }> = [];
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      send: () => {
        throw new Error("send should not be called");
      },
      close: (code?: number, reason?: string) => {
        closeCalls.push({
          ...(code !== undefined ? { code } : {}),
          ...(reason !== undefined ? { reason } : {}),
        });
      },
    };

    assert.equal(
      sendJsonWithBackpressure(
        socket,
        { output: "x".repeat(8_192) },
        {
          maxMessageBytes: 1_024,
          oversizedCloseReason: "test oversized frame",
        },
      ),
      false,
    );
    assert.deepEqual(closeCalls, [{ code: 1009, reason: "test oversized frame" }]);
  });

  test("rejects unregistered workspace file reads", async () => {
    const response = await requestJson({
      port,
      path: `/api/workspace/file?dir=${encodeURIComponent("/etc")}&path=${encodeURIComponent("hosts")}`,
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(response.json, { error: "Workspace directory is not registered." });
  });

  test("rejects session scopeRoot outside the registered workspace boundary", async () => {
    const scenarios = (await requestJson({
      port,
      path: "/api/debug/scenarios",
      headers: { Origin: `http://127.0.0.1:${port}` },
    })) as { status: number; json: { scenarios: Array<{ id: string }> } };
    assert.equal(scenarios.status, 200);
    const scenarioId = scenarios.json.scenarios[0]?.id;
    assert.equal(typeof scenarioId, "string");

    const started = (await requestJson({
      port,
      path: "/api/debug/scenarios/start",
      method: "POST",
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        "x-rah-client": "web",
      },
      body: { scenarioId },
    })) as { status: number; json: { session: { session: { id: string } } } };
    assert.equal(started.status, 200);
    const sessionId = started.json.session.session.id;

    const response = await requestJson({
      port,
      path:
        `/api/sessions/${sessionId}/file?path=${encodeURIComponent("README.md")}` +
        `&scopeRoot=${encodeURIComponent("/etc")}`,
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(response.json, { error: "Workspace directory is not registered." });
  });

  test("serves workspace file and search routes for a registered workspace", async () => {
    const nestedDir = path.join(tempHome, "project");
    writeFileSync(path.join(tempHome, "hello.txt"), "hello rah\n");
    writeFileSync(path.join(tempHome, "notes.md"), "workspace search target\n");

    const selected = await requestJson({
      port,
      path: "/api/workspaces/select",
      method: "POST",
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        "x-rah-client": "web",
      },
      body: { dir: tempHome },
    });
    assert.equal(selected.status, 200);

    const fileResponse = await requestJson({
      port,
      path:
        `/api/workspace/file?dir=${encodeURIComponent(tempHome)}` +
        `&path=${encodeURIComponent("hello.txt")}`,
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(fileResponse.status, 200);
    assert.equal(typeof fileResponse.json, "object");
    assert.equal((fileResponse.json as { content: string }).content, "hello rah\n");

    const searchResponse = await requestJson({
      port,
      path:
        `/api/workspace/file-search?dir=${encodeURIComponent(tempHome)}` +
        `&query=${encodeURIComponent("notes")}`,
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(searchResponse.status, 200);
    assert.equal(typeof searchResponse.json, "object");
    assert.deepEqual(
      (searchResponse.json as { files: Array<{ path: string }> }).files.map((entry) => entry.path),
      ["notes.md"],
    );

    void nestedDir;
  });

  test("serves frozen per-turn file summaries and exact file diffs independently of workspace git", async () => {
    const state = engine.sessionStore.createManagedSession({
      id: "session-http",
      provider: "codex",
      providerSessionId: "thread-http",
      launchSource: "web",
      cwd: tempHome,
      rootDir: tempHome,
    });
    const sessionId = state.session.id;
    const turnId = "turn-http";
    const filePath = "src/demo.ts";
    const frozenDiff = `diff --git a/${filePath} b/${filePath}
--- a/${filePath}
+++ b/${filePath}
@@ -1 +1 @@
-old
+new
`;
    await engine.turnArtifacts.replaceTurnDiff(
      turnArtifactOwnerKey(sessionId, state.session),
      turnId,
      frozenDiff,
    );

    const changesResponse = await requestJson({
      port,
      path:
        `/api/sessions/${encodeURIComponent(sessionId)}` +
        `/turns/${encodeURIComponent(turnId)}/file-changes`,
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(changesResponse.status, 200);
    assert.deepEqual(
      (changesResponse.json as {
        sessionId: string;
        turnId: string;
        fileChanges: {
          files: Array<{ path: string; additions: number; deletions: number }>;
          totalAdditions: number;
          totalDeletions: number;
        };
      }).fileChanges,
      {
        files: [{ path: filePath, additions: 1, deletions: 1 }],
        totalAdditions: 1,
        totalDeletions: 1,
      },
    );

    writeFileSync(path.join(tempHome, "demo.ts"), "workspace content changed later\n");
    const diffResponse = await requestJson({
      port,
      path:
        `/api/sessions/${encodeURIComponent(sessionId)}` +
        `/turns/${encodeURIComponent(turnId)}/file-diff` +
        `?path=${encodeURIComponent(filePath)}`,
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(diffResponse.status, 200);
    assert.deepEqual(diffResponse.json, {
      sessionId,
      turnId,
      path: filePath,
      diff: frozenDiff,
      truncated: false,
    });

    const missingPathResponse = await requestJson({
      port,
      path:
        `/api/sessions/${encodeURIComponent(sessionId)}` +
        `/turns/${encodeURIComponent(turnId)}/file-diff`,
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(missingPathResponse.status, 400);
    assert.deepEqual(missingPathResponse.json, { error: "File path is required." });
  });

  test("serves workspace git routes for a registered workspace", async () => {
    await requestJson({
      port,
      path: "/api/workspaces/select",
      method: "POST",
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        "x-rah-client": "web",
      },
      body: { dir: tempHome },
    });

    const gitStatus = await requestJson({
      port,
      path: `/api/workspace/git-status?dir=${encodeURIComponent(tempHome)}`,
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(gitStatus.status, 200);
    assert.equal(typeof gitStatus.json, "object");
    assert.deepEqual((gitStatus.json as { changedFiles: string[] }).changedFiles, []);

    const gitDiff = await requestJson({
      port,
      path:
        `/api/workspace/git-diff?dir=${encodeURIComponent(tempHome)}` +
        `&path=${encodeURIComponent("hello.txt")}`,
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(gitDiff.status, 200);
    assert.equal(typeof gitDiff.json, "object");
    assert.equal((gitDiff.json as { diff: string }).diff, "");
  });
});
