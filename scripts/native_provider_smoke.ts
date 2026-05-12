import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Provider = "claude" | "opencode";

type SessionEntry = {
  session: {
    id: string;
    provider: Provider;
    providerSessionId?: string;
    liveBackend?: string;
    nativeTui?: {
      terminalId: string;
      viewAvailable: boolean;
    };
    capabilities: {
      nativeTui?: boolean;
      rawPtyInput?: boolean;
      chatMirror?: boolean;
      structuredControl?: boolean;
    };
  };
  controlLease?: {
    holderClientId?: string;
  };
  attachedClients?: Array<{
    id: string;
  }>;
};

type PtyFrame =
  | { type: "pty.replay"; chunks: string[] }
  | { type: "pty.output"; data: string }
  | { type: "pty.exited"; exitCode?: number; signal?: string };

type ProviderConfig = {
  provider: Provider;
  envName: string;
  readyMarker: string;
  inputMarker: string;
  request: Record<string, unknown>;
  expectedArgFragments: string[];
  expectsPreboundProviderSessionId: boolean;
  expectsProviderSessionIdAfterBinding: boolean;
  expectsChatMirror: boolean;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const PROVIDERS: ProviderConfig[] = [
  {
    provider: "claude",
    envName: "RAH_CLAUDE_BINARY",
    readyMarker: "RAH_NATIVE_CLAUDE_READY",
    inputMarker: "RAH_NATIVE_CLAUDE_INPUT",
    request: {
      model: "opus",
      optionValues: { effort: "max" },
      modeId: "bypassPermissions",
    },
    expectedArgFragments: [
      "--permission-mode|bypassPermissions",
      "--model|opus",
      "--effort|max",
      "--session-id|",
    ],
    expectsPreboundProviderSessionId: true,
    expectsProviderSessionIdAfterBinding: true,
    expectsChatMirror: true,
  },
  {
    provider: "opencode",
    envName: "RAH_OPENCODE_BINARY",
    readyMarker: "RAH_NATIVE_OPENCODE_READY",
    inputMarker: "RAH_NATIVE_OPENCODE_INPUT",
    request: {
      model: "deepseek/deepseek-v4-pro",
      optionValues: { model_reasoning_variant: "high" },
      modeId: "build",
    },
    expectedArgFragments: [
      "--model|deepseek/deepseek-v4-pro",
      "--agent|build",
    ],
    expectsPreboundProviderSessionId: false,
    expectsProviderSessionIdAfterBinding: true,
    expectsChatMirror: true,
  },
];

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

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error(`Failed to open ${url}`)), {
      once: true,
    });
  });
  return socket;
}

function wsUrl(baseUrl: string, requestPath: string): string {
  return `${baseUrl.replace(/^http/, "ws")}${requestPath}`;
}

async function writeFakeProviderBinary(args: {
  path: string;
  provider: Provider;
  readyMarker: string;
  inputMarker: string;
}): Promise<void> {
  const claudeHistorySetup =
    args.provider === "claude"
      ? [
          "setTimeout(() => {",
          "  const configDir = process.env.CLAUDE_CONFIG_DIR;",
          "  const sessionArgIndex = process.argv.indexOf('--session-id');",
          "  const sessionId = sessionArgIndex >= 0 ? process.argv[sessionArgIndex + 1] : undefined;",
          "  if (!configDir || !sessionId) return;",
          "  const fs = require('node:fs');",
          "  const path = require('node:path');",
          "  const projectId = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');",
          "  const projectDir = path.join(configDir, 'projects', projectId);",
          "  const now = new Date().toISOString();",
          "  fs.mkdirSync(projectDir, { recursive: true });",
          "  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), [",
          "    JSON.stringify({ type: 'user', uuid: 'claude-native-user', cwd: process.cwd(), sessionId, timestamp: now, message: { content: 'Claude native smoke question' } }),",
          "    JSON.stringify({ type: 'assistant', uuid: 'claude-native-assistant', cwd: process.cwd(), sessionId, timestamp: now, message: { content: [{ type: 'text', text: 'Claude native smoke answer' }] } }),",
          "  ].join('\\n') + '\\n');",
          "}, 100);",
        ]
      : [];
  const opencodeHistorySetup =
    args.provider === "opencode"
      ? [
          "setTimeout(() => {",
          "  const dataHome = process.env.XDG_DATA_HOME;",
          "  const sessionId = process.env.MOCK_OPENCODE_SESSION_ID;",
          "  if (!dataHome || !sessionId) return;",
          "  const fs = require('node:fs');",
          "  const path = require('node:path');",
          "  const { execFileSync } = require('node:child_process');",
          "  const sql = (value) => `'${String(value).replace(/'/g, `''`)}'`;",
          "  const db = path.join(dataHome, 'opencode', 'opencode.db');",
          "  fs.mkdirSync(path.dirname(db), { recursive: true });",
          "  const now = Date.now();",
          "  const writeDb = (attempt = 0) => {",
          "    try {",
          "      execFileSync('sqlite3', [db, `",
          "    pragma busy_timeout = 5000;",
          "    create table if not exists project (id text primary key, worktree text, name text, time_updated integer);",
          "    create table if not exists session (id text primary key, project_id text not null, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer);",
          "    create table if not exists message (id text primary key, session_id text, time_created integer, time_updated integer, data text);",
          "    create table if not exists part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);",
          "    insert or replace into project (id, worktree, name, time_updated) values ('project_native', ${sql(process.cwd())}, null, ${now});",
          "    insert or replace into session (id, project_id, parent_id, directory, title, time_created, time_updated, time_archived)",
          "      values (${sql(sessionId)}, 'project_native', null, ${sql(process.cwd())}, 'OpenCode native smoke', ${now}, ${now}, null);",
          "    insert or replace into message (id, session_id, time_created, time_updated, data)",
          "      values ('msg_user_native', ${sql(sessionId)}, ${now + 10}, ${now + 10}, ${sql(JSON.stringify({ role: 'user', time: { created: now + 10 } }))});",
          "    insert or replace into message (id, session_id, time_created, time_updated, data)",
          "      values ('msg_assistant_native', ${sql(sessionId)}, ${now + 20}, ${now + 30}, ${sql(JSON.stringify({ role: 'assistant', parentID: 'msg_user_native', finish: 'stop', time: { created: now + 20, completed: now + 30 } }))});",
          "    insert or replace into part (id, message_id, session_id, time_created, time_updated, data)",
          "      values ('part_user_native', 'msg_user_native', ${sql(sessionId)}, ${now + 11}, ${now + 11}, ${sql(JSON.stringify({ type: 'text', text: 'OpenCode native smoke question' }))});",
          "    insert or replace into part (id, message_id, session_id, time_created, time_updated, data)",
          "      values ('part_assistant_native', 'msg_assistant_native', ${sql(sessionId)}, ${now + 21}, ${now + 30}, ${sql(JSON.stringify({ type: 'text', text: 'OpenCode native smoke answer' }))});",
          "      `]);",
          "    } catch (error) {",
          "      if (attempt < 20) {",
          "        setTimeout(() => writeDb(attempt + 1), 100);",
          "        return;",
          "      }",
          "      throw error;",
          "    }",
          "  };",
          "  writeDb();",
          "}, 100);",
        ]
      : [];
  await writeFile(
    args.path,
    [
      "#!/usr/bin/env node",
      `process.stdout.write(\`${args.readyMarker} args=\${process.argv.slice(2).join('|')}\\r\\n\`);`,
      ...claudeHistorySetup,
      ...opencodeHistorySetup,
      "process.stdin.setEncoding('utf8');",
      "process.stdin.resume();",
      "let buffer = '';",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += chunk;",
      "  if (buffer.includes('\\u0003')) {",
      `    process.stdout.write('${args.inputMarker}:INTERRUPTED\\r\\n');`,
      "    buffer = buffer.replace(/\\u0003/g, '');",
      "  }",
      "  const parts = buffer.split(/\\r|\\n/);",
      "  buffer = parts.pop() ?? '';",
      "  for (const part of parts) {",
      "    if (part.trim()) {",
      `      process.stdout.write(\`${args.inputMarker}:\${part.trim()}\\r\\n\`);`,
      "    }",
      "  }",
      "});",
      "setInterval(() => undefined, 1000);",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(args.path, 0o755);
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
  const baseUrl = await waitFor("daemon listen URL", () => {
    const match = stdout.match(/rah daemon listening on (http:\/\/127\.0\.0\.1:\d+)/);
    return match?.[1];
  }, { timeoutMs: 20_000 });
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

async function smokeProvider(args: {
  baseUrl: string;
  workspace: string;
  config: ProviderConfig;
}): Promise<{ sessionId: string; providerSessionId?: string }> {
  const clientId = `native-${args.config.provider}-smoke-${Date.now()}`;
  const started = await requestJson<{ session: SessionEntry }>(
    args.baseUrl,
    "/api/sessions/start",
    {
      method: "POST",
      body: JSON.stringify({
        provider: args.config.provider,
        cwd: args.workspace,
        liveBackend: "native_tui",
        title: `${args.config.provider} native smoke`,
        ...args.config.request,
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
  const sessionId = started.session.session.id;
  const terminalId = started.session.session.nativeTui?.terminalId;
  if (!terminalId || started.session.session.liveBackend !== "native_tui") {
    throw new Error(`${args.config.provider} did not start as native_tui.`);
  }
  if (
    started.session.session.capabilities.nativeTui !== true ||
    started.session.session.capabilities.rawPtyInput !== true ||
    started.session.session.capabilities.structuredControl !== false ||
    started.session.session.capabilities.chatMirror !== args.config.expectsChatMirror
  ) {
    throw new Error(`${args.config.provider} native capabilities are wrong.`);
  }
  if (
    args.config.expectsPreboundProviderSessionId &&
    !started.session.session.providerSessionId
  ) {
    throw new Error(`${args.config.provider} did not pre-bind providerSessionId.`);
  }
  if (
    !args.config.expectsPreboundProviderSessionId &&
    started.session.session.providerSessionId
  ) {
    throw new Error(`${args.config.provider} unexpectedly pre-bound providerSessionId.`);
  }

  const ptySocket = await openSocket(wsUrl(args.baseUrl, `/api/pty/${terminalId}`));
  let transcript = "";
  ptySocket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as PtyFrame;
    if (frame.type === "pty.replay") {
      transcript += frame.chunks.join("");
    } else if (frame.type === "pty.output") {
      transcript += frame.data;
    }
  });

  await waitFor(`${args.config.provider} native PTY ready`, () => {
    if (!transcript.includes(args.config.readyMarker)) {
      return false;
    }
    return args.config.expectedArgFragments.every((fragment) => transcript.includes(fragment));
  });

  const boundProviderSessionId = args.config.expectsProviderSessionIdAfterBinding
    ? await waitFor(`${args.config.provider} providerSessionId binding`, async () => {
        const summary = await requestJson<{ session: SessionEntry }>(
          args.baseUrl,
          `/api/sessions/${sessionId}`,
        );
        return summary.session.session.providerSessionId;
      })
    : undefined;

  const prompt = `hello ${args.config.provider} native`;
  await requestJson<Record<string, unknown>>(args.baseUrl, `/api/sessions/${sessionId}/input`, {
    method: "POST",
    body: JSON.stringify({ clientId, text: prompt }),
  });
  await waitFor(`${args.config.provider} native input`, () =>
    transcript.includes(`${args.config.inputMarker}:${prompt}`),
  );

  const latest = await requestJson<{ session: SessionEntry }>(
    args.baseUrl,
    `/api/sessions/${sessionId}`,
  );
  const closeClientId =
    latest.session.controlLease?.holderClientId ??
    latest.session.attachedClients?.[0]?.id ??
    clientId;
  await requestJson<Record<string, unknown>>(args.baseUrl, `/api/sessions/${sessionId}/close`, {
    method: "POST",
    body: JSON.stringify({ clientId: closeClientId }),
  });
  ptySocket.close();
  return {
    sessionId,
    ...(boundProviderSessionId
      ? { providerSessionId: boundProviderSessionId }
      : {}),
  };
}

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "rah-native-provider-smoke-"));
  const workspace = path.join(tmpRoot, "workspace");
  const rahHome = path.join(tmpRoot, "rah-home");
  const claudeConfigDir = path.join(tmpRoot, "claude-config");
  const opencodeProviderSessionId = `ses_${randomUUID().replace(/-/g, "")}`;
  const xdgDataHome = path.join(tmpRoot, "xdg-data");
  await mkdir(workspace, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RAH_PORT: String(await findFreePort()),
    RAH_HOME: rahHome,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    XDG_DATA_HOME: xdgDataHome,
    MOCK_OPENCODE_SESSION_ID: opencodeProviderSessionId,
  };
  for (const config of PROVIDERS) {
    const binary = path.join(tmpRoot, `fake-${config.provider}.js`);
    await writeFakeProviderBinary({
      path: binary,
      provider: config.provider,
      readyMarker: config.readyMarker,
      inputMarker: config.inputMarker,
    });
    env[config.envName] = binary;
  }

  const daemon = await startDaemon(env);
  const results: Array<{ provider: Provider; sessionId: string; providerSessionId?: string }> = [];
  try {
    for (const config of PROVIDERS) {
      const result = await smokeProvider({
        baseUrl: daemon.baseUrl,
        workspace,
        config,
      });
      results.push({ provider: config.provider, ...result });
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          baseUrl: daemon.baseUrl,
          asserted: [
            "Claude native TUI launch/input/close",
            "OpenCode native TUI launch/input/close",
            "Claude providerSessionId pre-bind",
            "Claude native sessions expose Chat/TUI from stored JSONL mirror",
            "OpenCode providerSessionId discovered from opencode.db",
          ],
          results,
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
          daemonStdoutTail: daemon.stdout().slice(-1600),
          daemonStderrTail: daemon.stderr().slice(-1600),
          results,
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await stopDaemon(daemon.process);
    await rm(tmpRoot, { force: true, recursive: true });
  }
}

void main().catch(() => {
  process.exitCode = 1;
});
