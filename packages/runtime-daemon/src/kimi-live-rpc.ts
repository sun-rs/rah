import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import {
  JSON_RPC_TIMEOUT_MS,
  type JsonRpcEvent,
  type JsonRpcRequest,
} from "./kimi-live-types";
import { resolveConfiguredBinary } from "./provider-binary-utils";

type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: string;
  result: unknown;
};

type JsonRpcError = {
  jsonrpc: "2.0";
  id: string | null;
  error: { code?: number; message?: string; data?: unknown };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class KimiJsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly stdout;
  private readonly stderr;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onEvent: (event: JsonRpcEvent) => void,
    private readonly onRequest: (request: JsonRpcRequest) => Promise<void>,
  ) {
    this.stdout = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.stderr = readline.createInterface({
      input: child.stderr,
      crlfDelay: Infinity,
    });
    this.stdout.on("line", (line) => {
      void this.handleStdoutLine(line);
    });
    this.child.once("exit", (code, signal) => {
      this.rejectAll(
        new Error(`Kimi wire process exited with code ${code ?? 0}${signal ? ` (${signal})` : ""}`),
      );
    });
  }

  onStderrLine(handler: (line: string) => void) {
    this.stderr.on("line", handler);
  }

  private async handleStdoutLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }
    const message = parsed as Record<string, unknown>;
    if (message.method === "event") {
      const params =
        message.params && typeof message.params === "object" && !Array.isArray(message.params)
          ? (message.params as Record<string, unknown>)
          : null;
      if (!params || typeof params.type !== "string") {
        return;
      }
      this.onEvent({
        jsonrpc: "2.0",
        method: "event",
        params: {
          type: params.type,
          payload:
            params.payload && typeof params.payload === "object" && !Array.isArray(params.payload)
              ? (params.payload as Record<string, unknown>)
              : {},
        },
      });
      return;
    }
    if (message.method === "request") {
      const params =
        message.params && typeof message.params === "object" && !Array.isArray(message.params)
          ? (message.params as Record<string, unknown>)
          : null;
      if (typeof message.id === "string" && params && typeof params.type === "string") {
        await this.onRequest({
          jsonrpc: "2.0",
          method: "request",
          id: message.id,
          params: {
            type: params.type,
            payload:
              params.payload && typeof params.payload === "object" && !Array.isArray(params.payload)
                ? (params.payload as Record<string, unknown>)
                : {},
          },
        });
        return;
      }
    }
    if (typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error && typeof message.error === "object" && !Array.isArray(message.error)) {
        const error = message as JsonRpcError;
        pending.reject(new Error(String(error.error.message ?? "JSON-RPC error")));
        return;
      }
      const success = message as JsonRpcSuccess;
      pending.resolve(success.result);
    }
  }

  private write(message: Record<string, unknown>) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = JSON_RPC_TIMEOUT_MS) {
    const id = `rah-kimi-${this.nextId++}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Kimi JSON-RPC response to ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
    });
  }

  respondSuccess(id: string, result: Record<string, unknown>) {
    this.write({
      jsonrpc: "2.0",
      id,
      result,
    });
  }

  respondError(id: string, message: string) {
    this.write({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32003,
        message,
      },
    });
  }

  async dispose() {
    this.rejectAll(new Error("Kimi JSON-RPC client disposed"));
    this.stdout.close();
    this.stderr.close();
    this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      this.child.once("exit", () => resolve());
      setTimeout(resolve, 2_000);
    });
  }

  private rejectAll(error: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export async function resolveKimiCommand(): Promise<{ command: string; args: string[] }> {
  if (process.env.RAH_KIMI_BINARY) {
    return { command: await resolveConfiguredBinary("RAH_KIMI_BINARY", "kimi"), args: [] };
  }
  if (process.env.RAH_KIMI_PROJECT) {
    return {
      command: "uv",
      args: ["run", "--project", process.env.RAH_KIMI_PROJECT, "kimi"],
    };
  }
  return { command: "kimi", args: [] };
}

export async function createKimiClient(params: {
  providerSessionId: string;
  cwd: string;
  model?: string;
  thinking?: boolean;
  yolo?: boolean;
  onEvent: (event: JsonRpcEvent) => void;
  onRequest: (request: JsonRpcRequest) => Promise<void>;
}) {
  const { command, args } = await resolveKimiCommand();
  const cliArgs = [...args];
  if (params.model) {
    cliArgs.push("--model", params.model);
    if (params.thinking === true) {
      cliArgs.push("--thinking");
    } else if (params.thinking === false) {
      cliArgs.push("--no-thinking");
    }
  }
  if (params.yolo) {
    cliArgs.push("--yolo");
  }
  cliArgs.push("--wire", "--session", params.providerSessionId);
  const child = spawn(command, cliArgs, {
    cwd: params.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new KimiJsonRpcClient(child, params.onEvent, params.onRequest);
  await client.request("initialize", {
    protocol_version: "1.9",
    client: {
      name: "rah",
      version: "0.0.0",
    },
    capabilities: {
      supports_question: true,
      supports_plan_mode: true,
    },
  });
  return client;
}
