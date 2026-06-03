import { spawn } from "node:child_process";
import readline from "node:readline";
import { WebSocket } from "ws";
import { resolveConfiguredBinary } from "./provider-binary-utils";
import {
  CodexJsonRpcClient,
  CodexWebSocketRpcClient,
  type CodexAppServerRpcClient,
} from "./codex-live-rpc";
import { rahNativeServerEnv } from "./native-local-server-orphans";

export { CodexJsonRpcClient, CodexWebSocketRpcClient, type CodexAppServerRpcClient } from "./codex-live-rpc";

function createInitializeParams() {
  return {
    clientInfo: {
      name: "rah",
      title: "rah",
      version: "0.0.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

async function resolveCodexBinary(): Promise<string> {
  return await resolveConfiguredBinary("RAH_CODEX_BINARY", "codex");
}

export async function createCodexStdioAppServerClient(binary?: string): Promise<CodexJsonRpcClient> {
  const resolvedBinary = binary ?? await resolveCodexBinary();
  const child = spawn(resolvedBinary, ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...rahNativeServerEnv("codex"),
    },
  });
  const client = new CodexJsonRpcClient(child);
  try {
    await client.request("initialize", createInitializeParams());
    client.notify("initialized", {});
    return client;
  } catch (error) {
    await client.dispose();
    throw error;
  }
}

async function waitForCodexWebSocketEndpoint(child: ReturnType<typeof spawn>): Promise<string> {
  if (!child.stderr) {
    throw new Error("Codex websocket app-server stderr is unavailable.");
  }
  const rl = readline.createInterface({ input: child.stderr });
  const stderrLines: string[] = [];
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Codex websocket app-server did not report an endpoint."));
    }, 5_000);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      rl.off("line", onLine);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onLine = (line: string) => {
      if (stderrLines.join("\n").length < 10_000) {
        stderrLines.push(line);
      }
      const match = line.match(/ws:\/\/[^\s]+/);
      if (!match) {
        return;
      }
      cleanup();
      resolve(match[0]);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Codex websocket app-server exited before endpoint: code=${code ?? "null"} signal=${signal ?? "null"} stderr=${stderrLines.join(" ").slice(0, 1_000)}`,
        ),
      );
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    rl.on("line", onLine);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function connectCodexWebSocket(endpoint: string): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Codex websocket connect timed out: ${endpoint}`));
    }, 10_000);
    timer.unref?.();
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export async function createCodexWebSocketAppServerClient(binary?: string): Promise<CodexWebSocketRpcClient> {
  const resolvedBinary = binary ?? await resolveCodexBinary();
  const child = spawn(resolvedBinary, ["app-server", "--listen", "ws://127.0.0.1:0"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      ...rahNativeServerEnv("codex"),
    },
  });
  let client: CodexWebSocketRpcClient | undefined;
  try {
    const endpoint = await waitForCodexWebSocketEndpoint(child);
    const socket = await connectCodexWebSocket(endpoint);
    client = new CodexWebSocketRpcClient(socket, child, endpoint);
    await client.request("initialize", createInitializeParams());
    client.notify("initialized", {});
    return client;
  } catch (error) {
    if (client) {
      await client.dispose().catch(() => undefined);
    } else if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    throw error;
  }
}

function shouldUseCodexWebSocketTransport(): boolean {
  const configured = process.env.RAH_CODEX_APP_SERVER_TRANSPORT?.trim().toLowerCase();
  if (configured === "stdio") {
    return false;
  }
  if (configured === "websocket" || configured === "ws") {
    return true;
  }
  return false;
}

export async function createCodexAppServerClient(): Promise<CodexAppServerRpcClient> {
  const binary = await resolveCodexBinary();
  if (!shouldUseCodexWebSocketTransport()) {
    return await createCodexStdioAppServerClient(binary);
  }
  try {
    return await createCodexWebSocketAppServerClient(binary);
  } catch (error) {
    if (process.env.RAH_CODEX_APP_SERVER_TRANSPORT?.trim()) {
      throw error;
    }
    return await createCodexStdioAppServerClient(binary);
  }
}
