import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { ProviderModelCatalog } from "@rah/runtime-protocol";
import { EventBus } from "./event-bus";
import {
  OpenCodeAdapter,
  readOpenCodeStartupModelCatalog,
} from "./provider-control/opencode-structured-adapter";
import {
  createOpenCodeMessageId,
  getOpenCodeMessages,
  promptOpenCodeSession,
  promptOpenCodeSessionAsync,
  startOpenCodeServer,
  stopOpenCodeServer,
} from "./opencode-api";
import {
  interruptOpenCodeLiveSession,
  normalizeOpenCodeLiveActivities,
  primeOpenCodeHistoryMirrorState,
  runtimeDiagnosticsForOpenCodeServer,
  sendInputToOpenCodeLiveSession,
  setOpenCodeLiveSessionMode,
  type LiveOpenCodeSession,
} from "./provider-control/opencode-live-client";
import { createOpenCodeActivityState } from "./opencode-activity";
import {
  buildOpenCodeProviderModelId,
  buildOpenCodeResolvedConfig,
  normalizeOpenCodeOptionValues,
  normalizeOpenCodeReasoningId,
} from "./opencode-model-catalog";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";
import { buildOpenCodeModeState } from "./session-mode-utils";

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Timed out waiting for condition"));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

test("OpenCode default variant normalizes to no explicit provider parameter", () => {
  assert.equal(
    buildOpenCodeProviderModelId({
      modelId: "deepseek/deepseek-v4-pro",
      reasoningId: "DEFAULT",
    }),
    "deepseek/deepseek-v4-pro",
  );
  assert.equal(
    buildOpenCodeProviderModelId({ modelId: "niubiwudi" }),
    "niubiwudi",
  );
  assert.equal(normalizeOpenCodeReasoningId("default"), null);
  assert.equal(normalizeOpenCodeReasoningId("HIGH"), "high");
  assert.deepEqual(
    normalizeOpenCodeOptionValues({ model_reasoning_variant: "DEFAULT" }),
    undefined,
  );
  assert.deepEqual(
    normalizeOpenCodeOptionValues({ model_reasoning_variant: "HIGH" }),
    { model_reasoning_variant: "high" },
  );
  assert.equal(
    buildOpenCodeResolvedConfig({ reasoningId: "default" }),
    undefined,
  );
});

test("OpenCode startup model discovery never blocks an interactive launch", async () => {
  let requestedCwd: string | undefined;
  let releaseDiscovery: ((catalog: ProviderModelCatalog) => void) | undefined;
  const discovery = new Promise<ProviderModelCatalog>((resolve) => {
    releaseDiscovery = resolve;
  });
  const catalog = readOpenCodeStartupModelCatalog(
    {
      getCached: () => null,
      listModels: (options) => {
        requestedCwd = options?.cwd;
        return discovery;
      },
    },
    "/tmp/rah-opencode-startup",
  );

  assert.equal(requestedCwd, "/tmp/rah-opencode-startup");
  assert.equal(catalog.provider, "opencode");
  assert.equal(catalog.source, "fallback");
  assert.equal(catalog.modelsExact, false);

  releaseDiscovery?.(catalog);
  await discovery;
});

test("OpenCode prompt APIs pass explicit model ids instead of falling back", async () => {
  const bodies: unknown[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (request.url?.includes("prompt_async")) {
        response.writeHead(204).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        info: {
          id: "msg-1",
          sessionID: "session-1",
          role: "assistant",
        },
        parts: [],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const handle = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    cwd: "/tmp",
  };
  try {
    await promptOpenCodeSessionAsync({
      handle,
      providerSessionId: "session-1",
      text: "hello",
      model: "niubiwudi",
      messageId: "msg_async-user",
    });
    await promptOpenCodeSession({
      handle,
      providerSessionId: "session-1",
      text: "hello",
      model: "aaa/wokao",
      messageId: "msg_sync-user",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.deepEqual(bodies.map((body) => (body as { model?: unknown }).model), [
    { providerID: "niubiwudi", modelID: "" },
    { providerID: "aaa", modelID: "wokao" },
  ]);
  assert.deepEqual(bodies.map((body) => (body as { messageID?: unknown }).messageID), [
    "msg_async-user",
    "msg_sync-user",
  ]);
});

test("OpenCode message reads request a bounded provider tail", async () => {
  let requestUrl = "";
  const server = http.createServer((request, response) => {
    requestUrl = request.url ?? "";
    response.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    assert.deepEqual(
      await getOpenCodeMessages(
        { baseUrl: `http://127.0.0.1:${address.port}`, cwd: "/tmp/rah opencode" },
        "session/tail",
        { limit: 8 },
      ),
      [],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const parsed = new URL(requestUrl, "http://127.0.0.1");
  assert.equal(parsed.pathname, "/session/session%2Ftail/message");
  assert.equal(parsed.searchParams.get("limit"), "8");
  assert.equal(parsed.searchParams.get("directory"), "/tmp/rah opencode");
});

test("createOpenCodeMessageId follows OpenCode's monotonic message identity format", () => {
  const first = createOpenCodeMessageId(1_700_000_000_000);
  const second = createOpenCodeMessageId(1_700_000_000_000);
  assert.match(first, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.match(second, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.ok(first.slice(4, 16) < second.slice(4, 16));
});

test("startOpenCodeServer rejects missing working directories before spawn", async () => {
  const previousBinary = process.env.RAH_OPENCODE_BINARY;
  const missingCwd = path.join(os.tmpdir(), `rah-opencode-missing-${Date.now()}`);
  try {
    process.env.RAH_OPENCODE_BINARY = process.execPath;
    await assert.rejects(
      () => startOpenCodeServer({ cwd: missingCwd }),
      /OpenCode working directory does not exist/i,
    );
  } finally {
    if (previousBinary === undefined) {
      delete process.env.RAH_OPENCODE_BINARY;
    } else {
      process.env.RAH_OPENCODE_BINARY = previousBinary;
    }
  }
});

test("stopOpenCodeServer tolerates process group permission errors", async () => {
  const previousKill = process.kill;
  const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (signal?: NodeJS.Signals | number) => boolean;
  };
  child.pid = 123456;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => false;
  process.kill = ((pid: number, signal?: NodeJS.Signals | 0) => {
    signals.push({ pid, signal });
    const error = new Error("kill EPERM") as NodeJS.ErrnoException;
    error.code = "EPERM";
    throw error;
  }) as typeof process.kill;
  try {
    await stopOpenCodeServer({
      baseUrl: "http://127.0.0.1:9",
      cwd: os.tmpdir(),
      child: child as unknown as ChildProcess,
    });
  } finally {
    process.kill = previousKill;
  }
  assert.deepEqual(signals, [
    { pid: -123456, signal: "SIGTERM" },
    { pid: -123456, signal: "SIGKILL" },
  ]);
});

test("runtimeDiagnosticsForOpenCodeServer exposes safe attach diagnostics", () => {
  const diagnostics = runtimeDiagnosticsForOpenCodeServer(
    {
      baseUrl: "http://127.0.0.1:43199",
      cwd: "/tmp/rah-opencode",
      child: { pid: 12345 },
    } as never,
    "opencode-session-1",
  );

  assert.deepEqual(diagnostics, {
    serverEndpoint: "http://127.0.0.1:43199",
    serverPid: 12345,
    attachCommand: "opencode attach http://127.0.0.1:43199 --session opencode-session-1",
    attachState: "ready",
    lastEventCursor: "session:opencode-session-1",
  });
});

test("interruptOpenCodeLiveSession ignores idle stops without requiring input control", () => {
  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const session = services.sessionStore.createManagedSession({
    provider: "opencode",
    providerSessionId: "opencode-1",
    launchSource: "web",
    cwd: "/tmp/rah-opencode",
    rootDir: "/tmp/rah-opencode",
  });
  let cancelCalled = false;
  const liveSession = {
    sessionId: session.session.id,
    providerSessionId: "opencode-1",
    queuedInputs: [],
    activityState: createOpenCodeActivityState("opencode-1"),
    server: {
      baseUrl: "http://127.0.0.1:1",
      cwd: "/tmp/rah-opencode",
    },
  } as unknown as LiveOpenCodeSession;

  interruptOpenCodeLiveSession({
    services,
    liveSession,
    request: {
      clientId: "web-client",
    },
  });
  assert.equal(cancelCalled, false);
});

test("sendInputToOpenCodeLiveSession queues consecutive inputs", async () => {
  const prompts: string[] = [];
  const pendingPromptResponses: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const body = rawBody ? JSON.parse(rawBody) : {};
      if (/\/message(?:\?|$)/.test(req.url ?? "")) {
        prompts.push(body.parts?.[0]?.text ?? "");
        pendingPromptResponses.push(res);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const session = services.sessionStore.createManagedSession({
    provider: "opencode",
    providerSessionId: "opencode-1",
    launchSource: "web",
    cwd: "/tmp/rah-opencode",
    rootDir: "/tmp/rah-opencode",
  });
  services.sessionStore.attachClient({
    sessionId: session.session.id,
    clientId: "terminal-client",
    kind: "web",
    connectionId: "test-web",
    attachMode: "interactive",
    focus: true,
  });
  services.sessionStore.claimControl(session.session.id, "terminal-client", "web");

  const liveSession = {
    sessionId: session.session.id,
    providerSessionId: "opencode-1",
    cwd: "/tmp/rah-opencode",
    modeId: "build",
    activityState: createOpenCodeActivityState("opencode-1"),
    queuedInputs: [],
    server: {
      baseUrl: `http://127.0.0.1:${address.port}`,
      cwd: "/tmp/rah-opencode",
    },
  } as unknown as LiveOpenCodeSession;

  try {
    sendInputToOpenCodeLiveSession({
      services,
      liveSession,
      request: { clientId: "web-user", text: "first" },
    });
    sendInputToOpenCodeLiveSession({
      services,
      liveSession,
      request: { clientId: "web-user", text: "second" },
    });

    await waitFor(() => prompts.length === 1);
    assert.deepEqual(prompts, ["first"]);
    assert.equal(liveSession.queuedInputs.length, 1);

    const events = services.eventBus.list({ sessionIds: [session.session.id] });
    // Web already owns the optimistic user bubble. The daemon should wait for
    // OpenCode's provider message instead of emitting a second provisional echo.
    assert.equal(
      events.filter(
        (event) =>
          event.type === "timeline.item.added" &&
          event.payload.item.kind === "user_message" &&
          event.payload.item.text === "first",
      ).length,
      0,
    );
  } finally {
    for (const response of pendingPromptResponses) {
      if (!response.writableEnded) {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          info: {
            id: "msg-final",
            sessionID: "opencode-1",
            role: "assistant",
            time: { completed: Date.now() },
            finish: "stop",
          },
          parts: [],
        }));
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("primeOpenCodeHistoryMirrorState records persisted identity without replaying turns", () => {
  const liveSession = {
    providerSessionId: "opencode-history-prime",
    activityState: createOpenCodeActivityState("opencode-history-prime", {
      userMessagesStartTurns: false,
      statusStartsTurns: false,
    }),
    mirroredMessageRevisions: new Map(),
  } as unknown as LiveOpenCodeSession;
  primeOpenCodeHistoryMirrorState(liveSession, [
    {
      info: {
        id: "msg-user-prime",
        sessionID: "opencode-history-prime",
        role: "user",
        time: { created: 1 },
      },
      parts: [
        {
          id: "part-user-prime",
          sessionID: "opencode-history-prime",
          messageID: "msg-user-prime",
          type: "text",
          text: "old question",
        },
      ],
    },
    {
      info: {
        id: "msg-assistant-prime",
        sessionID: "opencode-history-prime",
        role: "assistant",
        parentID: "msg-user-prime",
        finish: "stop",
        time: { created: 2, completed: 3 },
      },
      parts: [
        {
          id: "part-assistant-prime",
          sessionID: "opencode-history-prime",
          messageID: "msg-assistant-prime",
          type: "text",
          text: "old answer",
        },
      ],
    },
  ]);

  assert.equal(liveSession.mirroredMessageRevisions.size, 2);
  assert.equal(liveSession.activityState.currentTurnId, undefined);
  assert.equal(
    liveSession.activityState.turnByMessageId.get("msg-assistant-prime"),
    "opencode:msg-user-prime",
  );
  assert.equal(
    liveSession.activityState.turnRootMessageIdByMessageId.get("msg-assistant-prime"),
    "msg-user-prime",
  );
});

test("primeOpenCodeHistoryMirrorState keeps a bounded revision window", () => {
  const liveSession = {
    providerSessionId: "opencode-history-prime-bounded",
    activityState: createOpenCodeActivityState("opencode-history-prime-bounded", {
      userMessagesStartTurns: false,
      statusStartsTurns: false,
    }),
    mirroredMessageRevisions: new Map(),
  } as unknown as LiveOpenCodeSession;
  primeOpenCodeHistoryMirrorState(
    liveSession,
    Array.from({ length: 80 }, (_, index) => ({
      info: {
        id: `msg-user-${index}`,
        sessionID: "opencode-history-prime-bounded",
        role: "user" as const,
        time: { created: index },
      },
      parts: [
        {
          id: `part-user-${index}`,
          sessionID: "opencode-history-prime-bounded",
          messageID: `msg-user-${index}`,
          type: "text" as const,
          text: `question ${index}`,
        },
      ],
    })),
  );

  assert.equal(liveSession.mirroredMessageRevisions.size, 64);
  assert.equal(liveSession.mirroredMessageRevisions.has("msg-user-15"), false);
  assert.equal(liveSession.mirroredMessageRevisions.has("msg-user-16"), true);
  assert.equal(liveSession.mirroredMessageRevisions.has("msg-user-79"), true);
});

test("normalizeOpenCodeLiveActivities drops a provider abort error after local cancellation", () => {
  const liveSession = {
    activityState: createOpenCodeActivityState("opencode-local-cancel", {
      userMessagesStartTurns: false,
      statusStartsTurns: false,
    }),
    locallyCanceledTurnIds: new Set(["local-turn"]),
    localCancelMirrorSuppressUntilMs: Date.now() + 10_000,
  } as unknown as LiveOpenCodeSession;

  assert.deepEqual(
    normalizeOpenCodeLiveActivities(liveSession, [
      { type: "turn_failed", turnId: "provider-random-turn", error: "Aborted" },
    ]),
    [],
  );

  liveSession.activityState.currentTurnId = "next-turn";
  assert.deepEqual(
    normalizeOpenCodeLiveActivities(liveSession, [
      { type: "turn_failed", turnId: "next-turn", error: "real failure" },
    ]),
    [{ type: "turn_failed", turnId: "next-turn", error: "real failure" }],
  );
});

test("normalizeOpenCodeLiveActivities quarantines late output from an interrupted turn", () => {
  const liveSession = {
    activityState: createOpenCodeActivityState("opencode-late-output", {
      userMessagesStartTurns: false,
      statusStartsTurns: false,
      statusCompletesTurns: false,
    }),
    locallyCanceledTurnIds: new Set(["interrupted-turn"]),
  } as unknown as LiveOpenCodeSession;

  assert.deepEqual(
    normalizeOpenCodeLiveActivities(liveSession, [
      {
        type: "timeline_item",
        turnId: "interrupted-turn",
        item: { kind: "assistant_message", text: "late answer" },
      },
      { type: "turn_completed", turnId: "interrupted-turn" },
      {
        type: "timeline_item",
        turnId: "next-turn",
        item: { kind: "assistant_message", text: "current answer" },
      },
    ]),
    [
      {
        type: "timeline_item",
        turnId: "next-turn",
        item: { kind: "assistant_message", text: "current answer" },
      },
    ],
  );
});

test("interruptOpenCodeLiveSession settles the turn when OpenCode accepts abort", async () => {
  const promptRequests: Array<{ method: string; url: string; body: string }> = [];
  const abortRequests: Array<{ method: string; url: string; body: string }> = [];
  const pendingPromptResponses: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const record = {
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      };
      if (/\/message(?:\?|$)/.test(req.url ?? "")) {
        promptRequests.push(record);
        pendingPromptResponses.push(res);
        return;
      }
      abortRequests.push(record);
      res.setHeader("Content-Type", "application/json");
      res.end("true");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const services = {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
    };
    const session = services.sessionStore.createManagedSession({
      provider: "opencode",
      providerSessionId: "opencode-stop-1",
      launchSource: "web",
      cwd: "/tmp/rah-opencode",
      rootDir: "/tmp/rah-opencode",
    });
    services.sessionStore.attachClient({
      sessionId: session.session.id,
      clientId: "web-client",
      kind: "web",
      connectionId: "web-client",
      attachMode: "interactive",
      focus: true,
    });
    services.sessionStore.claimControl(session.session.id, "web-client", "web");

    const liveSession = {
      sessionId: session.session.id,
      providerSessionId: "opencode-stop-1",
      cwd: "/tmp/rah-opencode",
      modeId: "build",
      activityState: createOpenCodeActivityState("opencode-stop-1"),
      queuedInputs: [],
      server: {
        baseUrl: `http://127.0.0.1:${address.port}`,
        cwd: "/tmp/rah-opencode",
      },
    } as unknown as LiveOpenCodeSession;

    sendInputToOpenCodeLiveSession({
      services,
      liveSession,
      request: { clientId: "web-client", text: "stop immediately" },
    });
    await waitFor(
      () => services.sessionStore.getSession(session.session.id)?.session.runtimeState === "running",
    );

    const summary = interruptOpenCodeLiveSession({
      services,
      liveSession,
      request: { clientId: "web-client" },
    });
    interruptOpenCodeLiveSession({
      services,
      liveSession,
      request: { clientId: "web-client" },
    });

    await waitFor(() => promptRequests.length === 1 && abortRequests.length >= 1);
    await waitFor(
      () => services.sessionStore.getSession(session.session.id)?.session.runtimeState === "idle",
    );
    const state = services.sessionStore.getSession(session.session.id);
    assert.equal(summary.session.runtimeState, "running");
    assert.equal(state?.session.runtimeState, "idle");
    assert.equal(state?.activeTurnId, undefined);
    assert.equal(liveSession.activityState.currentTurnId, undefined);
    assert.equal(liveSession.queuedInputs.length, 0);
    assert.ok(abortRequests.length >= 1);
    assert.equal(abortRequests[0]?.method, "POST");
    assert.match(abortRequests[0]?.url ?? "", /\/session\/opencode-stop-1\/abort/);

    // The abort endpoint acknowledges the request before OpenCode publishes
    // session.status=idle. Queue draining is intentionally gated on that
    // provider lifecycle boundary so a late idle cannot close the next turn.
    liveSession.providerReadyForInput = true;
    sendInputToOpenCodeLiveSession({
      services,
      liveSession,
      request: { clientId: "web-client", text: "recovery after stop" },
    });
    await waitFor(() => promptRequests.length === 2);
    assert.equal(liveSession.queuedInputs.length, 0);

    assert.ok(
      services.eventBus
        .list({ sessionIds: [session.session.id] })
        .some((event) => event.type === "runtime.status" && event.payload.status === "thinking"),
    );
  } finally {
    for (const response of pendingPromptResponses) {
      if (!response.writableEnded) {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          info: {
            id: "msg-final",
            sessionID: "opencode-stop-1",
            role: "assistant",
            error: { name: "MessageAbortedError" },
            time: { completed: Date.now() },
          },
          parts: [],
        }));
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("interruptOpenCodeLiveSession treats a racing prompt error as cancellation", async () => {
  let pendingPromptResponse: http.ServerResponse | undefined;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (/\/message(?:\?|$)/.test(req.url ?? "")) {
        pendingPromptResponse = res;
        return;
      }
      if (/\/abort(?:\?|$)/.test(req.url ?? "")) {
        const promptResponse = pendingPromptResponse;
        if (promptResponse && !promptResponse.writableEnded) {
          promptResponse.statusCode = 500;
          promptResponse.setHeader("Content-Type", "application/json");
          promptResponse.end(JSON.stringify({ error: "Aborted" }));
        }
        setTimeout(() => {
          res.setHeader("Content-Type", "application/json");
          res.end("true");
        }, 100);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const services = {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
    };
    const session = services.sessionStore.createManagedSession({
      provider: "opencode",
      providerSessionId: "opencode-stop-race",
      launchSource: "web",
      cwd: "/tmp/rah-opencode",
      rootDir: "/tmp/rah-opencode",
    });
    const liveSession = {
      sessionId: session.session.id,
      providerSessionId: "opencode-stop-race",
      cwd: "/tmp/rah-opencode",
      modeId: "build",
      activityState: createOpenCodeActivityState("opencode-stop-race"),
      queuedInputs: [],
      server: {
        baseUrl: `http://127.0.0.1:${address.port}`,
        cwd: "/tmp/rah-opencode",
      },
    } as unknown as LiveOpenCodeSession;

    sendInputToOpenCodeLiveSession({
      services,
      liveSession,
      request: { clientId: "web-client", text: "stop during prompt response" },
    });
    await waitFor(() => pendingPromptResponse !== undefined);
    interruptOpenCodeLiveSession({
      services,
      liveSession,
      request: { clientId: "web-client" },
    });
    await waitFor(() =>
      services.eventBus
        .list({ sessionIds: [session.session.id] })
        .some((event) => event.type === "turn.canceled"),
    );

    const events = services.eventBus.list({ sessionIds: [session.session.id] });
    assert.equal(events.filter((event) => event.type === "turn.canceled").length, 1);
    assert.equal(events.some((event) => event.type === "turn.failed"), false);
    assert.equal(services.sessionStore.getSession(session.session.id)?.activeTurnId, undefined);
  } finally {
    if (pendingPromptResponse && !pendingPromptResponse.writableEnded) {
      pendingPromptResponse.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("setOpenCodeLiveSessionMode updates the OpenCode mode used by later prompts", async () => {
  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const session = services.sessionStore.createManagedSession({
    provider: "opencode",
    providerSessionId: "opencode-1",
    launchSource: "web",
    cwd: "/tmp/rah-opencode",
    rootDir: "/tmp/rah-opencode",
    mode: buildOpenCodeModeState({ currentModeId: "build", mutable: true }),
  });
  const liveSession = {
    sessionId: session.session.id,
    providerSessionId: "opencode-1",
    modeId: "build",
    server: {
      baseUrl: "http://127.0.0.1:1",
      cwd: "/tmp/rah-opencode",
    },
  } as unknown as LiveOpenCodeSession;

  const summary = await setOpenCodeLiveSessionMode({
    services,
    liveSession,
    modeId: "plan",
  });

  assert.equal(liveSession.modeId, "plan");
  assert.equal(summary.session.mode?.currentModeId, "plan");
});

test("setOpenCodeLiveSessionMode keeps OpenCode modes provider-native", async () => {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: rawBody ? JSON.parse(rawBody) : null,
      });
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          id: "opencode-1",
          directory: "/tmp/rah-opencode",
          title: "OpenCode",
          time: { created: 1, updated: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const services = {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
    };
    const session = services.sessionStore.createManagedSession({
      provider: "opencode",
      providerSessionId: "opencode-1",
      launchSource: "web",
      cwd: "/tmp/rah-opencode",
      rootDir: "/tmp/rah-opencode",
      mode: buildOpenCodeModeState({ currentModeId: "build", mutable: true }),
    });
    const liveSession = {
      sessionId: session.session.id,
      providerSessionId: "opencode-1",
      modeId: "build",
      server: {
        baseUrl: `http://127.0.0.1:${address.port}`,
        cwd: "/tmp/rah-opencode",
      },
    } as unknown as LiveOpenCodeSession;

    const build = await setOpenCodeLiveSessionMode({
      services,
      liveSession,
      modeId: "build",
    });
    assert.equal(build.session.mode?.currentModeId, "build");

    const plan = await setOpenCodeLiveSessionMode({
      services,
      liveSession,
      modeId: "plan",
    });
    assert.equal(plan.session.mode?.currentModeId, "plan");
    assert.equal(requests.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("setOpenCodeLiveSessionMode rejects non-native OpenCode modes", async () => {
  const requests: Array<{ body: unknown }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      requests.push({ body: rawBody ? JSON.parse(rawBody) : null });
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          id: "opencode-1",
          directory: "/tmp/rah-opencode",
          title: "OpenCode",
          time: { created: 1, updated: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const services = {
      eventBus: new EventBus(),
      ptyHub: new PtyHub(),
      sessionStore: new SessionStore(),
    };
    const session = services.sessionStore.createManagedSession({
      provider: "opencode",
      providerSessionId: "opencode-1",
      launchSource: "web",
      cwd: "/tmp/rah-opencode",
      rootDir: "/tmp/rah-opencode",
      mode: buildOpenCodeModeState({ currentModeId: "build", mutable: true }),
    });
    const liveSession = {
      sessionId: session.session.id,
      providerSessionId: "opencode-1",
      modeId: "build",
      server: {
        baseUrl: `http://127.0.0.1:${address.port}`,
        cwd: "/tmp/rah-opencode",
      },
    } as unknown as LiveOpenCodeSession;

    await assert.rejects(
      setOpenCodeLiveSessionMode({
        services,
        liveSession,
        modeId: "opencode/full-auto",
      }),
      /Unsupported OpenCode mode 'opencode\/full-auto'/,
    );
    assert.equal(requests.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("OpenCodeAdapter setSessionModel stores provider model and variant for later prompts", async () => {
  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const adapter = new OpenCodeAdapter(services);
  const session = services.sessionStore.createManagedSession({
    provider: "opencode",
    providerSessionId: "opencode-1",
    launchSource: "web",
    cwd: "/tmp/rah-opencode",
    rootDir: "/tmp/rah-opencode",
    capabilities: {
      modelSwitch: true,
    },
    mode: buildOpenCodeModeState({ currentModeId: "build", mutable: true }),
  });
  const catalog: ProviderModelCatalog = {
    provider: "opencode",
    models: [
      {
        id: "openai/gpt-5.5",
        defaultReasoningId: null,
        reasoningOptions: [
          { id: "xhigh", label: "XHigh", kind: "reasoning_effort" },
        ],
      },
    ],
    modelProfiles: [
      {
        modelId: "openai/gpt-5.5",
        source: "native_online",
        freshness: "authoritative",
        configOptions: [
          {
            id: "model_reasoning_variant",
            label: "Reasoning variant",
            kind: "select",
            scope: "model",
            source: "native_online",
            mutable: true,
            applyTiming: "next_turn",
            options: [
              { id: "xhigh", label: "XHigh" },
            ],
            availability: { modelIds: ["openai/gpt-5.5"] },
            backendKey: "variant",
          },
        ],
      },
    ],
    fetchedAt: new Date().toISOString(),
    source: "native",
  };
  const internals = adapter as unknown as {
    liveSessions: Map<string, LiveOpenCodeSession>;
    modelCatalog: {
      listModels: () => ProviderModelCatalog;
    };
  };
  internals.modelCatalog = {
    listModels: () => catalog,
  };
  const liveSession = {
    sessionId: session.session.id,
    providerSessionId: "opencode-1",
    cwd: "/tmp/rah-opencode",
    modeId: "build",
  } as unknown as LiveOpenCodeSession;
  internals.liveSessions.set(session.session.id, liveSession);

  const updated = await adapter.setSessionModel(session.session.id, {
    modelId: "openai/gpt-5.5",
    optionValues: { model_reasoning_variant: "xhigh" },
  });

  assert.equal(liveSession.model, "openai/gpt-5.5");
  assert.equal(liveSession.reasoningId, "xhigh");
  assert.equal(updated.session.model?.currentModelId, "openai/gpt-5.5");
  assert.equal(updated.session.model?.currentReasoningId, "xhigh");
});

test("OpenCodeAdapter setSessionModel preserves user-supplied models missing from catalog", async () => {
  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const adapter = new OpenCodeAdapter(services);
  const session = services.sessionStore.createManagedSession({
    provider: "opencode",
    providerSessionId: "opencode-1",
    launchSource: "web",
    cwd: "/tmp/rah-opencode",
    rootDir: "/tmp/rah-opencode",
    capabilities: {
      modelSwitch: true,
    },
    mode: buildOpenCodeModeState({ currentModeId: "build", mutable: true }),
  });
  const catalog: ProviderModelCatalog = {
    provider: "opencode",
    models: [{ id: "deepseek/deepseek-v4-pro" }],
    fetchedAt: new Date().toISOString(),
    source: "native",
  };
  const internals = adapter as unknown as {
    liveSessions: Map<string, LiveOpenCodeSession>;
    modelCatalog: {
      listModels: () => ProviderModelCatalog;
    };
  };
  internals.modelCatalog = {
    listModels: () => catalog,
  };
  const liveSession = {
    sessionId: session.session.id,
    providerSessionId: "opencode-1",
    cwd: "/tmp/rah-opencode",
    modeId: "build",
  } as unknown as LiveOpenCodeSession;
  internals.liveSessions.set(session.session.id, liveSession);

  const updated = await adapter.setSessionModel(session.session.id, {
    modelId: "niubiwudi",
  });

  assert.equal(liveSession.model, "niubiwudi");
  assert.equal(updated.session.model?.currentModelId, "niubiwudi");
});
