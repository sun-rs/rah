import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { resolveConfiguredBinary } from "./provider-binary-utils";

export interface OpenCodeServerHandle {
  baseUrl: string;
  cwd: string;
  child: ChildProcess;
  authHeader?: string;
}

export interface OpenCodeSessionInfo {
  id: string;
  directory: string;
  title: string;
  parentID?: string;
  time: {
    created: number;
    updated: number;
    archived?: number;
  };
}

export interface OpenCodeMessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  parentID?: string;
  agent?: string;
  providerID?: string;
  modelID?: string;
  finish?: string;
  error?: unknown;
  time?: {
    created?: number;
    completed?: number;
  };
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: {
      read?: number;
      write?: number;
    };
  };
  cost?: number;
}

export type OpenCodeToolState =
  | {
      status: "pending";
      input?: Record<string, unknown>;
      raw?: string;
    }
  | {
      status: "running";
      input?: Record<string, unknown>;
      title?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      status: "completed";
      input?: Record<string, unknown>;
      output?: string;
      title?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      status: "error";
      input?: Record<string, unknown>;
      error?: string;
      metadata?: Record<string, unknown>;
    };

export type OpenCodePart =
  | {
      id: string;
      sessionID: string;
      messageID: string;
      type: "text";
      text?: string;
      synthetic?: boolean;
      ignored?: boolean;
    }
  | {
      id: string;
      sessionID: string;
      messageID: string;
      type: "reasoning";
      text?: string;
    }
  | {
      id: string;
      sessionID: string;
      messageID: string;
      type: "tool";
      callID: string;
      tool: string;
      state: OpenCodeToolState;
      metadata?: Record<string, unknown>;
    }
  | {
      id: string;
      sessionID: string;
      messageID: string;
      type: "file";
      mime?: string;
      filename?: string;
      url?: string;
    }
  | {
      id: string;
      sessionID: string;
      messageID: string;
      type: string;
      [key: string]: unknown;
    };

export interface OpenCodeMessageWithParts {
  info: OpenCodeMessageInfo;
  parts: OpenCodePart[];
}

export interface OpenCodeEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export async function resolveOpenCodeBinary(): Promise<string> {
  return await resolveConfiguredBinary("RAH_OPENCODE_BINARY", "opencode");
}

export async function allocateOpenCodePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
          return;
        }
        reject(new Error("Failed to allocate an OpenCode server port."));
      });
    });
  });
}

export async function startOpenCodeServer(params: {
  cwd: string;
  port?: number;
  onOutput?: (data: string) => void;
}): Promise<OpenCodeServerHandle> {
  const port = params.port ?? (await allocateOpenCodePort());
  const binary = await resolveOpenCodeBinary();
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: params.cwd,
    env: process.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk: Buffer) => {
    params.onOutput?.(chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    params.onOutput?.(chunk.toString("utf8"));
  });
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const handle: OpenCodeServerHandle = {
    baseUrl: `http://127.0.0.1:${port}`,
    cwd: params.cwd,
    child,
    ...(password
      ? { authHeader: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
      : {}),
  };
  await waitForOpenCodeServer(handle);
  return handle;
}

export async function stopOpenCodeServer(handle: OpenCodeServerHandle): Promise<void> {
  if (!handle.child.pid) {
    return;
  }
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(killTimer);
      handle.child.off("exit", finish);
      resolve();
    };
    const killTimer = setTimeout(() => {
      signalOpenCodeServer(handle, "SIGKILL");
      finish();
    }, 2_000);
    handle.child.once("exit", finish);
    signalOpenCodeServer(handle, "SIGTERM");
  });
}

function signalOpenCodeServer(handle: OpenCodeServerHandle, signal: NodeJS.Signals): void {
  const pid = handle.child.pid;
  if (!pid) {
    return;
  }
  try {
    if (process.platform === "win32") {
      handle.child.kill(signal);
      return;
    }
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

export async function waitForOpenCodeServer(handle: OpenCodeServerHandle): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) {
      throw new Error(`OpenCode server exited early with code ${handle.child.exitCode}.`);
    }
    try {
      await openCodeRequestJson<Record<string, unknown>>(handle, "/path");
      return;
    } catch (error) {
      lastError = error;
      await delay(200);
    }
  }
  throw new Error(
    `Timed out waiting for OpenCode server at ${handle.baseUrl}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export async function openCodeRequestJson<T>(
  handle: Pick<OpenCodeServerHandle, "baseUrl" | "cwd" | "authHeader">,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await openCodeFetch(handle, path, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenCode API ${path} failed with HTTP ${response.status}${body ? `: ${body}` : ""}`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export async function openCodeFetch(
  handle: Pick<OpenCodeServerHandle, "baseUrl" | "cwd" | "authHeader">,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = new URL(path, handle.baseUrl);
  if (!url.searchParams.has("directory")) {
    url.searchParams.set("directory", handle.cwd);
  }
  const headers = new Headers(options.headers);
  if (handle.authHeader && !headers.has("Authorization")) {
    headers.set("Authorization", handle.authHeader);
  }
  return await fetch(url, {
    ...options,
    headers,
  });
}

export async function createOpenCodeSession(
  handle: Pick<OpenCodeServerHandle, "baseUrl" | "cwd" | "authHeader">,
  options: { title?: string } = {},
): Promise<OpenCodeSessionInfo> {
  return await openCodeRequestJson<OpenCodeSessionInfo>(handle, "/session", {
    method: "POST",
    body: JSON.stringify(options.title ? { title: options.title } : {}),
  });
}

export async function getOpenCodeSession(
  handle: Pick<OpenCodeServerHandle, "baseUrl" | "cwd" | "authHeader">,
  providerSessionId: string,
): Promise<OpenCodeSessionInfo> {
  return await openCodeRequestJson<OpenCodeSessionInfo>(
    handle,
    `/session/${encodeURIComponent(providerSessionId)}`,
  );
}

export async function listOpenCodeSessions(
  handle: Pick<OpenCodeServerHandle, "baseUrl" | "cwd" | "authHeader">,
): Promise<OpenCodeSessionInfo[]> {
  return await openCodeRequestJson<OpenCodeSessionInfo[]>(handle, "/session?roots=true");
}

export async function getOpenCodeMessages(
  handle: Pick<OpenCodeServerHandle, "baseUrl" | "cwd" | "authHeader">,
  providerSessionId: string,
): Promise<OpenCodeMessageWithParts[]> {
  return await openCodeRequestJson<OpenCodeMessageWithParts[]>(
    handle,
    `/session/${encodeURIComponent(providerSessionId)}/message`,
  );
}

export async function promptOpenCodeSessionAsync(params: {
  handle: Pick<OpenCodeServerHandle, "baseUrl" | "cwd" | "authHeader">;
  providerSessionId: string;
  text: string;
  model?: string;
}): Promise<void> {
  const body: {
    parts: Array<{ type: "text"; text: string }>;
    model?: { providerID: string; modelID: string };
  } = {
    parts: [{ type: "text", text: params.text }],
  };
  const model = parseOpenCodeModel(params.model);
  if (model) {
    body.model = model;
  }
  await openCodeRequestJson<void>(
    params.handle,
    `/session/${encodeURIComponent(params.providerSessionId)}/prompt_async`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

export async function abortOpenCodeSession(params: {
  handle: Pick<OpenCodeServerHandle, "baseUrl" | "cwd" | "authHeader">;
  providerSessionId: string;
}): Promise<void> {
  await openCodeRequestJson<boolean>(
    params.handle,
    `/session/${encodeURIComponent(params.providerSessionId)}/abort`,
    {
      method: "POST",
      body: "{}",
    },
  );
}

export async function archiveOpenCodeSession(params: {
  handle: Pick<OpenCodeServerHandle, "baseUrl" | "cwd" | "authHeader">;
  providerSessionId: string;
}): Promise<OpenCodeSessionInfo> {
  return await openCodeRequestJson<OpenCodeSessionInfo>(
    params.handle,
    `/session/${encodeURIComponent(params.providerSessionId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ time: { archived: Date.now() } }),
    },
  );
}

export type OpenCodePermissionRule = {
  permission: string;
  pattern: string;
  action: "allow" | "deny" | "ask";
};

export async function setOpenCodeSessionPermission(params: {
  handle: Pick<OpenCodeServerHandle, "baseUrl" | "cwd" | "authHeader">;
  providerSessionId: string;
  permission: OpenCodePermissionRule[];
}): Promise<OpenCodeSessionInfo> {
  return await openCodeRequestJson<OpenCodeSessionInfo>(
    params.handle,
    `/session/${encodeURIComponent(params.providerSessionId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ permission: params.permission }),
    },
  );
}

export async function deleteOpenCodeSession(params: {
  handle: Pick<OpenCodeServerHandle, "baseUrl" | "cwd" | "authHeader">;
  providerSessionId: string;
}): Promise<void> {
  await openCodeRequestJson<boolean>(
    params.handle,
    `/session/${encodeURIComponent(params.providerSessionId)}`,
    { method: "DELETE" },
  );
}

export async function respondOpenCodePermission(params: {
  handle: Pick<OpenCodeServerHandle, "baseUrl" | "cwd" | "authHeader">;
  requestId: string;
  reply: "once" | "always" | "reject";
  message?: string;
}): Promise<void> {
  await openCodeRequestJson<boolean>(
    params.handle,
    `/permission/${encodeURIComponent(params.requestId)}/reply`,
    {
      method: "POST",
      body: JSON.stringify({
        reply: params.reply,
        ...(params.message ? { message: params.message } : {}),
      }),
    },
  );
}

export function subscribeOpenCodeEvents(params: {
  handle: Pick<OpenCodeServerHandle, "baseUrl" | "cwd" | "authHeader">;
  signal?: AbortSignal;
  onEvent: (event: OpenCodeEvent) => void;
  onError?: (error: unknown) => void;
}): () => void {
  const controller = new AbortController();
  const abort = () => controller.abort();
  params.signal?.addEventListener("abort", abort, { once: true });
  void (async () => {
    try {
      const response = await openCodeFetch(params.handle, "/event", {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`OpenCode event stream failed with HTTP ${response.status}`);
      }
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        const events = extractSseData(buffer);
        buffer = events.remainder;
        for (const data of events.items) {
          const parsed = JSON.parse(data) as OpenCodeEvent;
          params.onEvent(parsed);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        params.onError?.(error);
      }
    } finally {
      params.signal?.removeEventListener("abort", abort);
    }
  })();
  return abort;
}

function extractSseData(buffer: string): { items: string[]; remainder: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const remainder = parts.pop() ?? "";
  const items = parts
    .map((part) =>
      part
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim(),
    )
    .filter((part) => part.length > 0);
  return { items, remainder };
}

function parseOpenCodeModel(model: string | undefined):
  | {
      providerID: string;
      modelID: string;
    }
  | undefined {
  if (!model) {
    return undefined;
  }
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    return undefined;
  }
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  };
}
