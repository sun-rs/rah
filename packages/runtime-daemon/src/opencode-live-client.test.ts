import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { ProviderModelCatalog } from "@rah/runtime-protocol";
import { EventBus } from "./event-bus";
import { OpenCodeAdapter } from "./opencode-adapter";
import { startOpenCodeServer } from "./opencode-api";
import {
  interruptOpenCodeLiveSession,
  sendInputToOpenCodeLiveSession,
  setOpenCodeLiveSessionMode,
  type LiveOpenCodeSession,
} from "./opencode-live-client";
import { createOpenCodeActivityState } from "./opencode-activity";
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

test("interruptOpenCodeLiveSession requires input control before canceling", () => {
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
    acp: {
      cancel: () => {
        cancelCalled = true;
      },
    },
  } as unknown as LiveOpenCodeSession;

  assert.throws(
    () =>
      interruptOpenCodeLiveSession({
        services,
        liveSession,
        request: {
          clientId: "web-client",
        },
      }),
    /does not hold input control/,
  );
  assert.equal(cancelCalled, false);
});

test("sendInputToOpenCodeLiveSession queues consecutive inputs", async () => {
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
    clientId: "web-client",
    kind: "web",
    connectionId: "web-client",
    attachMode: "interactive",
    focus: true,
  });
  services.sessionStore.claimControl(session.session.id, "web-client", "web");

  const prompts: string[] = [];
  const releases: Array<() => void> = [];
  const liveSession = {
    sessionId: session.session.id,
    providerSessionId: "opencode-1",
    cwd: "/tmp/rah-opencode",
    modeId: "build",
    activityState: createOpenCodeActivityState("opencode-1"),
    lastAcpActivityAt: Date.now(),
    queuedInputs: [],
    acp: {
      prompt: async (_sessionId: string, text: string) => {
        prompts.push(text);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return { usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 } };
      },
    },
  } as unknown as LiveOpenCodeSession;

  sendInputToOpenCodeLiveSession({
    services,
    liveSession,
    request: { clientId: "web-client", text: "first" },
  });
  sendInputToOpenCodeLiveSession({
    services,
    liveSession,
    request: { clientId: "web-client", text: "second" },
  });

  await waitFor(() => prompts.length === 1);
  assert.deepEqual(prompts, ["first"]);
  releases.shift()?.();
  await waitFor(() => prompts.length === 2);
  assert.deepEqual(prompts, ["first", "second"]);
  releases.shift()?.();
  await waitFor(
    () => services.sessionStore.getSession(session.session.id)?.session.runtimeState === "idle",
  );

  const events = services.eventBus.list({ sessionIds: [session.session.id] });
  assert.equal(
    events.filter(
      (event) =>
        event.type === "timeline.item.added" &&
        event.payload.item.kind === "user_message" &&
        ["first", "second"].includes(event.payload.item.text),
    ).length,
    2,
  );
  assert.equal(events.filter((event) => event.type === "turn.completed").length, 2);
});

test("interruptOpenCodeLiveSession stops an active web turn immediately", async () => {
  const abortRequests: Array<{ method: string; url: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      abortRequests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
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

    let cancelCalled = false;
    const liveSession = {
      sessionId: session.session.id,
      providerSessionId: "opencode-stop-1",
      cwd: "/tmp/rah-opencode",
      modeId: "build",
      activityState: createOpenCodeActivityState("opencode-stop-1"),
      lastAcpActivityAt: Date.now(),
      queuedInputs: [],
      server: {
        baseUrl: `http://127.0.0.1:${address.port}`,
        cwd: "/tmp/rah-opencode",
      },
      acp: {
        prompt: async () => await new Promise<never>(() => undefined),
        cancel: async (providerSessionId: string) => {
          assert.equal(providerSessionId, "opencode-stop-1");
          cancelCalled = true;
        },
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

    assert.equal(summary.session.runtimeState, "idle");
    await waitFor(() => cancelCalled && abortRequests.length === 1);
    const state = services.sessionStore.getSession(session.session.id);
    assert.equal(state?.session.runtimeState, "idle");
    assert.equal(state?.activeTurnId, undefined);
    assert.equal(liveSession.activityState.currentTurnId, undefined);
    assert.equal(liveSession.queuedInputs.length, 0);
    assert.equal(abortRequests[0]?.method, "POST");
    assert.match(abortRequests[0]?.url ?? "", /\/session\/opencode-stop-1\/abort/);
    assert.ok(
      services.eventBus
        .list({ sessionIds: [session.session.id] })
        .some((event) => event.type === "turn.canceled"),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("setOpenCodeLiveSessionMode applies ACP mode changes", async () => {
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
  const calls: Array<{ sessionId: string; modeId: string }> = [];
  const liveSession = {
    sessionId: session.session.id,
    providerSessionId: "opencode-1",
    modeId: "build",
    acp: {
      setSessionMode: async (sessionId: string, modeId: string) => {
        calls.push({ sessionId, modeId });
      },
    },
  } as unknown as LiveOpenCodeSession;

  const summary = await setOpenCodeLiveSessionMode({
    services,
    liveSession,
    modeId: "plan",
  });

  assert.deepEqual(calls, [{ sessionId: "opencode-1", modeId: "plan" }]);
  assert.equal(liveSession.modeId, "plan");
  assert.equal(summary.session.mode?.currentModeId, "plan");
});

test("setOpenCodeLiveSessionMode maps full auto to OpenCode session permissions", async () => {
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
    const acpCalls: Array<{ sessionId: string; modeId: string }> = [];
    const liveSession = {
      sessionId: session.session.id,
      providerSessionId: "opencode-1",
      modeId: "build",
      server: {
        baseUrl: `http://127.0.0.1:${address.port}`,
        cwd: "/tmp/rah-opencode",
      },
      acp: {
        setSessionMode: async (sessionId: string, modeId: string) => {
          acpCalls.push({ sessionId, modeId });
        },
      },
    } as unknown as LiveOpenCodeSession;

    const fullAuto = await setOpenCodeLiveSessionMode({
      services,
      liveSession,
      modeId: "opencode/full-auto",
    });
    assert.deepEqual(acpCalls[0], { sessionId: "opencode-1", modeId: "build" });
    assert.equal(fullAuto.session.mode?.currentModeId, "opencode/full-auto");
    assert.deepEqual(requests[0]?.body, {
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    });

    const normal = await setOpenCodeLiveSessionMode({
      services,
      liveSession,
      modeId: "build",
    });
    assert.deepEqual(acpCalls[1], { sessionId: "opencode-1", modeId: "build" });
    assert.equal(normal.session.mode?.currentModeId, "build");
    assert.deepEqual(requests[1]?.body, {
      permission: [{ permission: "*", pattern: "*", action: "ask" }],
    });

    await setOpenCodeLiveSessionMode({
      services,
      liveSession,
      modeId: "opencode/full-auto",
    });
    const plan = await setOpenCodeLiveSessionMode({
      services,
      liveSession,
      modeId: "plan",
    });
    assert.deepEqual(acpCalls[2], { sessionId: "opencode-1", modeId: "build" });
    assert.deepEqual(acpCalls[3], { sessionId: "opencode-1", modeId: "plan" });
    assert.equal(plan.session.mode?.currentModeId, "plan");
    assert.deepEqual(requests[2]?.body, {
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    });
    assert.deepEqual(requests[3]?.body, {
      permission: [{ permission: "*", pattern: "*", action: "ask" }],
    });

    const fullAutoAgain = await setOpenCodeLiveSessionMode({
      services,
      liveSession,
      modeId: "opencode/full-auto",
    });
    assert.deepEqual(acpCalls[4], { sessionId: "opencode-1", modeId: "build" });
    assert.equal(fullAutoAgain.session.mode?.currentModeId, "opencode/full-auto");
    assert.deepEqual(requests[4]?.body, {
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("setOpenCodeLiveSessionMode maps build to ask permissions", async () => {
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
      acp: {
        setSessionMode: async () => undefined,
      },
    } as unknown as LiveOpenCodeSession;

    const summary = await setOpenCodeLiveSessionMode({
      services,
      liveSession,
      modeId: "build",
    });

    assert.equal(summary.session.mode?.currentModeId, "build");
    assert.deepEqual(requests[0]?.body, {
      permission: [{ permission: "*", pattern: "*", action: "ask" }],
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("OpenCodeAdapter setSessionModel applies provider model and reasoning through ACP", async () => {
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
        label: "OpenAI/GPT-5.5",
        defaultReasoningId: "default",
        reasoningOptions: [
          { id: "default", label: "Base", kind: "model_variant" },
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
            defaultValue: "default",
            options: [
              { id: "default", label: "Base" },
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
  const calls: Array<{ sessionId: string; modelId: string }> = [];
  const internals = adapter as unknown as {
    liveSessions: Map<string, LiveOpenCodeSession>;
    modelCatalog: {
      listModels: () => ProviderModelCatalog;
    };
  };
  internals.modelCatalog = {
    listModels: () => catalog,
  };
  internals.liveSessions.set(session.session.id, {
    sessionId: session.session.id,
    providerSessionId: "opencode-1",
    cwd: "/tmp/rah-opencode",
    modeId: "build",
    acp: {
      setSessionModel: async (sessionId: string, modelId: string) => {
        calls.push({ sessionId, modelId });
      },
    },
  } as unknown as LiveOpenCodeSession);

  const updated = await adapter.setSessionModel(session.session.id, {
    modelId: "openai/gpt-5.5",
    optionValues: { model_reasoning_variant: "xhigh" },
  });

  assert.deepEqual(calls, [
    {
      sessionId: "opencode-1",
      modelId: "openai/gpt-5.5/xhigh",
    },
  ]);
  assert.equal(updated.session.model?.currentModelId, "openai/gpt-5.5");
  assert.equal(updated.session.model?.currentReasoningId, "xhigh");
});
