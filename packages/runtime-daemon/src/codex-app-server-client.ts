import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { WebSocket } from "ws";
import { providerBinaryArgv, resolveConfiguredBinary } from "./provider-binary-utils";
import {
  CODEX_RPC_MAX_MESSAGE_BYTES,
  CodexJsonRpcClient,
  CodexWebSocketRpcClient,
  type CodexAppServerRpcClient,
} from "./codex-live-rpc";
import { rahNativeServerEnv } from "./native-local-server-orphans";
import { providerProcessEnv } from "./provider-process-env";
import {
  applyBackgroundProcessPriority,
  backgroundProcessLaunch,
} from "./background-process-priority";
import { BackpressuredByteIngress } from "./backpressured-byte-ingress";

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
  const [command, ...prefixArgs] = providerBinaryArgv(resolvedBinary);
  if (!command) {
    throw new Error("Codex app-server command is empty.");
  }
  const launch = backgroundProcessLaunch(command, [...prefixArgs, "app-server"]);
  const child = spawn(launch.command, launch.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: providerProcessEnv(rahNativeServerEnv("codex")),
  });
  applyBackgroundProcessPriority(
    child.pid,
    "codex app-server stdio",
    launch.priority,
  );
  // JSON-RPC uses stdout. Codex diagnostics on stderr are intentionally
  // discarded in native flowing mode so an unread pipe cannot stall the
  // provider and no per-chunk JavaScript work can starve the daemon.
  child.stderr.resume();
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
  const stderr = child.stderr;
  const decoder = new StringDecoder("utf8");
  const maxLineBytes = 64 * 1024;
  const maxDiagnosticBytes = 8 * 1024;
  let lineBuffer = "";
  let diagnosticTail = "";
  let stderrEnded = false;
  let processEnded = false;
  let processEndError: Error | undefined;
  let settled = false;

  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      finish(
        undefined,
        new Error("Codex websocket app-server did not report an endpoint."),
      );
    }, 5_000);
    timer.unref?.();

    const cleanup = () => {
      clearTimeout(timer);
      stderr.off("data", onData);
      stderr.off("end", onStderrEnd);
      stderr.off("error", onStderrError);
      child.off("exit", onExit);
      child.off("close", onClose);
      child.off("error", onError);
      ingress.dispose();
      // Endpoint discovery is the only semantic use of stderr. Keep draining
      // the pipe without JS listeners for the lifetime of the app-server.
      stderr.resume();
    };
    const finish = (endpoint?: string, error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve(endpoint!);
      }
    };
    const appendDiagnostic = (line: string) => {
      diagnosticTail = `${diagnosticTail}${diagnosticTail ? "\n" : ""}${line}`;
      if (Buffer.byteLength(diagnosticTail, "utf8") > maxDiagnosticBytes) {
        diagnosticTail = Buffer.from(diagnosticTail, "utf8")
          .subarray(-maxDiagnosticBytes)
          .toString("utf8");
      }
    };
    const consumeLine = (line: string) => {
      appendDiagnostic(line);
      const match = line.match(/ws:\/\/[^\s]+/);
      if (match) {
        finish(match[0]);
      }
    };
    const consume = (chunk: Buffer<ArrayBufferLike>) => {
      if (settled) {
        return;
      }
      lineBuffer += decoder.write(chunk);
      if (Buffer.byteLength(lineBuffer, "utf8") > maxLineBytes) {
        finish(
          undefined,
          new Error("Codex websocket app-server emitted an oversized endpoint line."),
        );
        return;
      }
      let newline = lineBuffer.indexOf("\n");
      while (newline >= 0 && !settled) {
        const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
        lineBuffer = lineBuffer.slice(newline + 1);
        consumeLine(line);
        newline = lineBuffer.indexOf("\n");
      }
    };
    const maybeFinishEnded = () => {
      if (settled || !processEnded || !stderrEnded || !ingress.isIdle()) {
        return;
      }
      lineBuffer += decoder.end();
      if (lineBuffer) {
        consumeLine(lineBuffer);
        lineBuffer = "";
      }
      if (!settled) {
        finish(
          undefined,
          processEndError ??
            new Error(
              `Codex websocket app-server exited before endpoint: stderr=${diagnosticTail.slice(-1_000)}`,
            ),
        );
      }
    };
    const ingress = new BackpressuredByteIngress({
      consume,
      pauseSource: () => stderr.pause(),
      resumeSource: () => stderr.resume(),
      onIdle: maybeFinishEnded,
    });
    const onData = (chunk: Buffer | string) => {
      ingress.enqueue(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinishEnded();
    };
    const onStderrError = (error: Error) => {
      finish(undefined, error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      processEnded = true;
      processEndError = new Error(
        `Codex websocket app-server exited before endpoint: code=${code ?? "null"} signal=${signal ?? "null"} stderr=${diagnosticTail.slice(-1_000)}`,
      );
      maybeFinishEnded();
    };
    const onClose = () => {
      processEnded = true;
      stderrEnded = true;
      maybeFinishEnded();
    };
    const onError = (error: Error) => {
      finish(undefined, error);
    };

    stderr.on("data", onData);
    stderr.once("end", onStderrEnd);
    stderr.once("error", onStderrError);
    child.once("exit", onExit);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

async function connectCodexWebSocket(endpoint: string): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    // Reject an oversized frame inside ws before it is converted to a string
    // and synchronously parsed on the daemon event loop.
    const socket = new WebSocket(endpoint, {
      maxPayload: CODEX_RPC_MAX_MESSAGE_BYTES,
    });
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
  const [command, ...prefixArgs] = providerBinaryArgv(resolvedBinary);
  if (!command) {
    throw new Error("Codex app-server command is empty.");
  }
  const launch = backgroundProcessLaunch(command, [
    ...prefixArgs,
    "app-server",
    "--listen",
    "ws://127.0.0.1:0",
  ]);
  const child = spawn(launch.command, launch.args, {
    stdio: ["ignore", "ignore", "pipe"],
    env: providerProcessEnv(rahNativeServerEnv("codex")),
  });
  applyBackgroundProcessPriority(
    child.pid,
    "codex app-server websocket",
    launch.priority,
  );
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
  return true;
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
