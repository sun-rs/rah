import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { ProviderModelCatalog } from "@rah/runtime-protocol";
import { EventBus } from "./event-bus";
import { OpenCodeAdapter } from "./provider-control/opencode-structured-adapter";
import {
  promptOpenCodeSession,
  promptOpenCodeSessionAsync,
  startOpenCodeServer,
} from "./opencode-api";
import {
  interruptOpenCodeLiveSession,
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
    });
    await promptOpenCodeSession({
      handle,
      providerSessionId: "session-1",
      text: "hello",
      model: "aaa/wokao",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.deepEqual(bodies.map((body) => (body as { model?: unknown }).model), [
    { providerID: "niubiwudi", modelID: "" },
    { providerID: "aaa", modelID: "wokao" },
  ]);
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
    kind: "terminal",
    connectionId: "pid:test-terminal",
    attachMode: "interactive",
    focus: true,
  });
  services.sessionStore.claimControl(session.session.id, "terminal-client", "terminal");

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
