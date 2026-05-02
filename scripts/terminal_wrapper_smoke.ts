import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const baseUrl = process.env.RAH_BASE_URL ?? "http://127.0.0.1:43111";
const providers = ["codex", "claude", "gemini", "kimi", "opencode"] as const;
type Provider = (typeof providers)[number];

type JsonObject = Record<string, unknown>;

async function requestJson<T>(pathName: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${pathName}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

function wsUrl(pathName: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = pathName;
  url.search = "";
  return url.toString();
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function send(socket: WebSocket, message: JsonObject): void {
  socket.send(JSON.stringify(message));
}

async function waitForSummary(
  sessionId: string,
  predicate: (summary: JsonObject) => boolean,
  describe: string,
): Promise<JsonObject> {
  return await waitFor(asyncReadSummary(sessionId, predicate), describe, 10_000);
}

function asyncReadSummary(
  sessionId: string,
  predicate: (summary: JsonObject) => boolean,
): () => Promise<JsonObject | undefined> {
  return async () => {
    try {
      const response = await requestJson<{ session: JsonObject }>(`/api/sessions/${sessionId}`);
      return predicate(response.session) ? response.session : undefined;
    } catch {
      return undefined;
    }
  };
}

async function waitFor<T>(
  read: (() => T | undefined) | (() => Promise<T | undefined>),
  describe: string,
  timeoutMs = 10_000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${describe}.`);
}

function canonicalIdentity(provider: Provider, providerSessionId: string, turnId: string) {
  return {
    canonicalItemId: `smoke:${provider}:${providerSessionId}:${turnId}:assistant`,
    canonicalTurnId: `smoke:${provider}:${providerSessionId}:${turnId}`,
    provider,
    providerSessionId,
    turnKey: turnId,
    itemKind: "assistant_message",
    itemKey: "assistant-1",
    origin: "live",
    confidence: "derived",
  };
}

async function runProvider(provider: Provider) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), `rah-wrapper-${provider}-`));
  const wrapperMessages: JsonObject[] = [];
  const eventBatches: JsonObject[] = [];
  const eventSocket = new WebSocket(wsUrl("/api/events"));
  const wrapperSocket = new WebSocket(wsUrl("/api/wrapper-control"));
  const providerSessionId = `wrapper-smoke-${provider}-${Date.now()}`;
  const webClientId = `web-wrapper-smoke-${provider}-${Date.now()}`;
  let sessionId = "";

  try {
    eventSocket.on("message", (raw) => {
      try {
        eventBatches.push(JSON.parse(raw.toString()) as JsonObject);
      } catch {
        // Ignore malformed frames; the smoke asserts expected valid frames below.
      }
    });
    wrapperSocket.on("message", (raw) => {
      wrapperMessages.push(JSON.parse(raw.toString()) as JsonObject);
    });
    await Promise.all([waitForSocketOpen(eventSocket), waitForSocketOpen(wrapperSocket)]);

    send(wrapperSocket, {
      type: "wrapper.hello",
      provider,
      cwd,
      rootDir: cwd,
      terminalPid: process.pid,
      launchCommand: ["rah", provider, "resume", providerSessionId],
      resumeProviderSessionId: providerSessionId,
    });

    const ready = await waitFor(
      () => wrapperMessages.find((message) => message.type === "wrapper.ready"),
      `${provider} wrapper.ready`,
    );
    sessionId = String(ready.sessionId);

    await waitForSummary(
      sessionId,
      (summary) => (summary.session as JsonObject | undefined)?.provider === provider,
      `${provider} session registration`,
    );

    send(wrapperSocket, {
      type: "wrapper.provider_bound",
      sessionId,
      providerSessionId,
      providerTitle: `${provider} wrapper smoke`,
      providerPreview: "terminal wrapper smoke",
      reason: "resume",
    });
    await waitForSummary(
      sessionId,
      (summary) => (summary.session as JsonObject | undefined)?.providerSessionId === providerSessionId,
      `${provider} provider binding`,
    );

    send(wrapperSocket, {
      type: "wrapper.prompt_state.changed",
      sessionId,
      state: "prompt_clean",
    });
    await waitForSummary(
      sessionId,
      (summary) => (summary.session as JsonObject | undefined)?.runtimeState === "idle",
      `${provider} idle prompt state`,
    );

    const promptText = `RAH_WRAPPER_SMOKE_${provider}`;
    await requestJson(`/api/sessions/${sessionId}/input`, {
      method: "POST",
      body: JSON.stringify({ clientId: webClientId, text: promptText }),
    });
    const inject = await waitFor(
      () =>
        wrapperMessages.find(
          (message) =>
            message.type === "turn.inject" &&
            (message.queuedTurn as JsonObject | undefined)?.text === promptText,
        ),
      `${provider} turn.inject`,
    );
    const queuedTurn = inject.queuedTurn as JsonObject;
    const turnId = String(queuedTurn.queuedTurnId);

    send(wrapperSocket, {
      type: "wrapper.prompt_state.changed",
      sessionId,
      state: "agent_busy",
    });
    send(wrapperSocket, {
      type: "wrapper.activity",
      sessionId,
      activity: { type: "turn_started", turnId },
    });
    send(wrapperSocket, {
      type: "wrapper.activity",
      sessionId,
      activity: {
        type: "timeline_item",
        turnId,
        item: {
          kind: "assistant_message",
          text: `${provider} wrapper smoke response`,
          messageId: "assistant-1",
        },
        identity: canonicalIdentity(provider, providerSessionId, turnId),
      },
    });
    send(wrapperSocket, {
      type: "wrapper.activity",
      sessionId,
      activity: { type: "turn_completed", turnId },
    });
    send(wrapperSocket, {
      type: "wrapper.prompt_state.changed",
      sessionId,
      state: "prompt_clean",
    });

    await waitForSummary(
      sessionId,
      (summary) => (summary.session as JsonObject | undefined)?.runtimeState === "idle",
      `${provider} completed turn`,
    );
    await waitFor(
      () =>
        eventBatches.some((batch) => {
          const events = batch.events;
          return (
            Array.isArray(events) &&
            events.some((event) => {
              if (!event || typeof event !== "object") {
                return false;
              }
              const record = event as JsonObject;
              const payload = record.payload as JsonObject | undefined;
              const item = payload?.item as JsonObject | undefined;
              const identity = payload?.identity as JsonObject | undefined;
              return (
                record.sessionId === sessionId &&
                record.type === "timeline.item.added" &&
                item?.kind === "assistant_message" &&
                item?.text === `${provider} wrapper smoke response` &&
                identity?.canonicalItemId === canonicalIdentity(provider, providerSessionId, turnId).canonicalItemId
              );
            })
          );
        })
          ? true
          : undefined,
      `${provider} canonical assistant event`,
    );

    await requestJson(`/api/sessions/${sessionId}/close`, {
      method: "POST",
      body: JSON.stringify({ clientId: webClientId }),
    });
    await waitFor(
      () => wrapperMessages.find((message) => message.type === "wrapper.close"),
      `${provider} wrapper.close`,
    );
    send(wrapperSocket, {
      type: "wrapper.exited",
      sessionId,
      exitCode: 0,
    });
    await waitFor(
      async () => {
        const response = await requestJson<{ sessions: Array<{ session: JsonObject }> }>("/api/sessions");
        return response.sessions.some((entry) => (entry.session as JsonObject).id === sessionId)
          ? undefined
          : true;
      },
      `${provider} wrapper cleanup`,
    );

    return {
      provider,
      sessionId,
      providerSessionId,
      injectedTurnId: turnId,
      eventCount: eventBatches.reduce((count, batch) => (
        count + (Array.isArray(batch.events) ? batch.events.length : 0)
      ), 0),
    };
  } finally {
    eventSocket.close();
    wrapperSocket.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function main() {
  const requested = process.argv.slice(2);
  const selected =
    requested.length > 0
      ? requested.map((provider) => {
          if (!providers.includes(provider as Provider)) {
            throw new Error(`Unsupported provider ${provider}.`);
          }
          return provider as Provider;
        })
      : [...providers];
  const results = [];
  for (const provider of selected) {
    results.push(await runProvider(provider));
  }
  console.log(JSON.stringify({ ok: true, baseUrl, results }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
