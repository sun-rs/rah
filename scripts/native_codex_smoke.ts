import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;

type SessionEntry = {
  session: {
    id: string;
    provider: string;
    providerSessionId?: string;
    liveBackend?: string;
    nativeTui?: {
      terminalId: string;
      viewAvailable: boolean;
    };
    runtimeState: string;
    capabilities: {
      nativeTui?: boolean;
      rawPtyInput?: boolean;
      chatMirror?: boolean;
      structuredTimeline?: boolean;
    };
  };
  controlLease?: {
    holderClientId?: string;
  };
  attachedClients?: Array<{
    id: string;
  }>;
};

type EventBatch = {
  events?: Array<{
    sessionId?: string;
    type?: string;
    payload?: {
      item?: {
        kind?: string;
        text?: string;
      };
      identity?: {
        canonicalItemId?: string;
      };
    };
  }>;
};

type PtyFrame =
  | { type: "pty.replay"; chunks: string[] }
  | { type: "pty.output"; data: string }
  | { type: "pty.exited"; exitCode?: number; signal?: string };

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

async function requestJson<T>(
  baseUrl: string,
  requestPath: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${requestPath}: ${text}`);
  }
  return body as T;
}

async function waitFor<T>(
  label: string,
  check: () => T | Promise<T>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 100;
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
  );
}

function websocketUrl(baseUrl: string, requestPath: string): string {
  return `${baseUrl.replace(/^http/, "ws")}${requestPath}`;
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error(`Failed to open websocket ${url}`)),
      { once: true },
    );
  });
  return socket;
}

async function writeFakeCodexBinary(fakeCodexPath: string): Promise<void> {
  await writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const providerSessionId = process.env.MOCK_CODEX_SESSION_ID;",
      "const codexHome = process.env.CODEX_HOME;",
      "if (!providerSessionId || !codexHome) {",
      "  console.error('missing MOCK_CODEX_SESSION_ID or CODEX_HOME');",
      "  process.exit(2);",
      "}",
      "const rolloutPath = path.join(codexHome, 'sessions', `rollout-native-smoke-${providerSessionId}.jsonl`);",
      "fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });",
      "function append(row) { fs.appendFileSync(rolloutPath, JSON.stringify(row) + '\\n'); }",
      "function timestamp(offsetMs = 0) { return new Date(Date.now() + offsetMs).toISOString(); }",
      "append({",
      "  timestamp: timestamp(),",
      "  type: 'session_meta',",
      "  payload: { id: providerSessionId, cwd: process.cwd(), timestamp: timestamp() },",
      "});",
      "process.stdout.write(`RAH_NATIVE_CODEX_READY args=${process.argv.slice(2).join('|')}\\r\\n`);",
      "process.stdout.write(`Session: ${providerSessionId}\\r\\n`);",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.resume();",
      "let buffer = '';",
      "let turnIndex = 0;",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += chunk;",
      "  if (buffer.includes('\\u0003')) {",
      "    process.stdout.write('RAH_NATIVE_CODEX_INTERRUPTED\\r\\n');",
      "    buffer = buffer.replace(/\\u0003/g, '');",
      "  }",
      "  const parts = buffer.split(/\\r|\\n/);",
      "  buffer = parts.pop() ?? '';",
      "  for (const raw of parts) {",
      "    const text = raw.trim();",
      "    if (!text) continue;",
      "    turnIndex += 1;",
      "    const turnId = `native-smoke-turn-${turnIndex}`;",
      "    const answer = `RAH_NATIVE_CODEX_MIRROR_${turnIndex}`;",
      "    process.stdout.write(`RAH_NATIVE_CODEX_INPUT:${text}\\r\\n`);",
      "    append({ timestamp: timestamp(1), type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } });",
      "    append({",
      "      timestamp: timestamp(2),",
      "      type: 'response_item',",
      "      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },",
      "    });",
      "    append({",
      "      timestamp: timestamp(3),",
      "      type: 'event_msg',",
      "      payload: { type: 'agent_message', message: answer },",
      "    });",
      "    append({",
      "      timestamp: timestamp(4),",
      "      type: 'response_item',",
      "      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] },",
      "    });",
      "    append({ timestamp: timestamp(5), type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } });",
      "    process.stdout.write(`RAH_NATIVE_CODEX_ANSWER:${answer}\\r\\n`);",
      "  }",
      "});",
      "setInterval(() => undefined, 1000);",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(fakeCodexPath, 0o755);
}

async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not resolve free TCP port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function startDaemon(env: NodeJS.ProcessEnv): Promise<{
  process: ChildProcessWithoutNullStreams;
  baseUrl: string;
  stdout: () => string;
  stderr: () => string;
}> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "packages/runtime-daemon/src/main.ts"],
    {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const baseUrl = await waitFor(
    "daemon listen URL",
    () => {
      const match = stdout.match(/rah daemon listening on (http:\/\/127\.0\.0\.1:\d+)/);
      return match?.[1];
    },
    { timeoutMs: 20_000 },
  );

  return {
    process: child,
    baseUrl,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function stopDaemon(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

function hasTimelineText(batches: EventBatch[], sessionId: string, kind: string, text: string): boolean {
  return batches.some((batch) =>
    (batch.events ?? []).some(
      (event) =>
        event.sessionId === sessionId &&
        event.type === "timeline.item.added" &&
        event.payload?.item?.kind === kind &&
        event.payload.item.text === text &&
        typeof event.payload.identity?.canonicalItemId === "string",
      ),
  );
}

function countTimelineText(batches: EventBatch[], sessionId: string, kind: string, text: string): number {
  let count = 0;
  for (const batch of batches) {
    for (const event of batch.events ?? []) {
      if (
        event.sessionId === sessionId &&
        event.type === "timeline.item.added" &&
        event.payload?.item?.kind === kind &&
        event.payload.item.text === text
      ) {
        count += 1;
      }
    }
  }
  return count;
}

async function resolveSessionClientId(
  baseUrl: string,
  sessionId: string,
  fallback: string,
): Promise<string> {
  const summary = await requestJson<{ session: SessionEntry }>(
    baseUrl,
    `/api/sessions/${sessionId}`,
  );
  return (
    summary.session.controlLease?.holderClientId ??
    summary.session.attachedClients?.[0]?.id ??
    fallback
  );
}

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "rah-native-codex-smoke-"));
  const workspace = path.join(tmpRoot, "workspace");
  const rahHome = path.join(tmpRoot, "rah-home");
  const codexHome = path.join(tmpRoot, "codex-home");
  const fakeCodex = path.join(tmpRoot, "fake-codex.js");
  const providerSessionId = randomUUID();
  const clientId = `native-codex-smoke-${Date.now()}`;
  const prompt = "RAH native Codex smoke prompt";
  const expectedAnswer = "RAH_NATIVE_CODEX_MIRROR_1";

  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(codexHome, "sessions"), { recursive: true });
  await writeFakeCodexBinary(fakeCodex);
  const port = await findFreePort();

  const daemon = await startDaemon({
    ...process.env,
    RAH_PORT: String(port),
    RAH_HOME: rahHome,
    CODEX_HOME: codexHome,
    RAH_CODEX_BINARY: fakeCodex,
    MOCK_CODEX_SESSION_ID: providerSessionId,
  });

  let ptySocket: WebSocket | null = null;
  let eventSocket: WebSocket | null = null;
  let sessionId: string | null = null;
  let transcript = "";
  const eventBatches: EventBatch[] = [];

  try {
    eventSocket = await openSocket(websocketUrl(daemon.baseUrl, "/api/events"));
    eventSocket.addEventListener("message", (event) => {
      try {
        eventBatches.push(JSON.parse(String(event.data)) as EventBatch);
      } catch {
        // The smoke only asserts valid JSON RAH event batches.
      }
    });

    const started = await requestJson<{ session: SessionEntry }>(
      daemon.baseUrl,
      "/api/sessions/start",
      {
        method: "POST",
        body: JSON.stringify({
          provider: "codex",
          cwd: workspace,
          liveBackend: "native_tui",
          model: "gpt-native-smoke",
          modeId: "never/danger-full-access",
          attach: {
            client: {
              id: clientId,
              kind: "web",
              connectionId: clientId,
            },
            mode: "interactive",
            claimControl: true,
          },
        }),
      },
    );
    sessionId = started.session.session.id;
    const nativeTui = started.session.session.nativeTui;
    if (started.session.session.liveBackend !== "native_tui" || !nativeTui?.terminalId) {
      throw new Error("Codex session did not start as native_tui.");
    }
    if (
      started.session.session.capabilities.nativeTui !== true ||
      started.session.session.capabilities.rawPtyInput !== true ||
      started.session.session.capabilities.chatMirror !== true
    ) {
      throw new Error("Native Codex capabilities were not advertised.");
    }

    ptySocket = await openSocket(websocketUrl(daemon.baseUrl, `/api/pty/${nativeTui.terminalId}`));
    ptySocket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as PtyFrame;
      if (frame.type === "pty.replay") {
        transcript += frame.chunks.join("");
      } else if (frame.type === "pty.output") {
        transcript += frame.data;
      }
    });

    await waitFor("native Codex PTY ready output", () =>
      transcript.includes("RAH_NATIVE_CODEX_READY") &&
      transcript.includes("--model|gpt-native-smoke") &&
      transcript.includes("--dangerously-bypass-approvals-and-sandbox"),
    );

    await waitFor("provider session id binding", async () => {
      const summary = await requestJson<{ session: SessionEntry }>(
        daemon.baseUrl,
        `/api/sessions/${sessionId}`,
      );
      return summary.session.session.providerSessionId === providerSessionId;
    });

    await requestJson<JsonObject>(daemon.baseUrl, `/api/sessions/${sessionId}/input`, {
      method: "POST",
      body: JSON.stringify({ clientId, text: prompt }),
    });

    await waitFor("native Codex PTY input echo", () =>
      transcript.includes(`RAH_NATIVE_CODEX_INPUT:${prompt}`),
    );

    await waitFor(
      "Codex rollout mirror events",
      () =>
        hasTimelineText(eventBatches, sessionId!, "user_message", prompt) &&
        hasTimelineText(eventBatches, sessionId!, "assistant_message", expectedAnswer),
      { timeoutMs: 8_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const answerCount = countTimelineText(eventBatches, sessionId!, "assistant_message", expectedAnswer);
    if (answerCount !== 1) {
      throw new Error(`Codex rollout mirror duplicated assistant answer; count=${answerCount}`);
    }

    await waitFor("native Codex runtime idle", async () => {
      const summary = await requestJson<{ session: SessionEntry }>(
        daemon.baseUrl,
        `/api/sessions/${sessionId}`,
      );
      return summary.session.session.runtimeState === "idle";
    });

    const closeClientId = await resolveSessionClientId(daemon.baseUrl, sessionId, clientId);
    await requestJson<JsonObject>(daemon.baseUrl, `/api/sessions/${sessionId}/close`, {
      method: "POST",
      body: JSON.stringify({ clientId: closeClientId }),
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          baseUrl: daemon.baseUrl,
          sessionId,
          providerSessionId,
          workspace,
          asserted: [
            "native_tui backend",
            "PTY view",
            "chat input injected into PTY",
            "providerSessionId binding",
            "Codex rollout chat mirror",
            "Codex rollout mirror dedupes agent_message plus assistant response_item",
            "runtime returned idle",
            "native session close",
          ],
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          sessionId,
          providerSessionId,
          transcriptTail: transcript.slice(-1600),
          eventBatchCount: eventBatches.length,
          daemonStdoutTail: daemon.stdout().slice(-1600),
          daemonStderrTail: daemon.stderr().slice(-1600),
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    ptySocket?.close();
    eventSocket?.close();
    await stopDaemon(daemon.process);
    await rm(tmpRoot, { force: true, recursive: true });
  }
}

void main().catch(() => {
  process.exitCode = 1;
});
