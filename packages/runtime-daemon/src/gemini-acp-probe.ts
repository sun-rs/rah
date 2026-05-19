import { spawn, type ChildProcess } from "node:child_process";
import { resolveConfiguredBinary } from "./provider-binary-utils";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

type JsonRpcIncoming =
  | { jsonrpc: "2.0"; id: number; result?: unknown; error?: { message?: string } | unknown }
  | { jsonrpc: "2.0"; method: string; params?: unknown };

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timeout: NodeJS.Timeout;
}

export interface GeminiAcpModel {
  id: string;
  description?: string;
}

export interface GeminiAcpMode {
  id: string;
  label: string;
  description?: string;
}

export interface GeminiAcpProbeResult {
  currentModelId?: string;
  models: GeminiAcpModel[];
  currentModeId?: string;
  modes: GeminiAcpMode[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function acpModelId(model: Record<string, unknown>): string | null {
  return asNonEmptyString(model.modelId) ?? asNonEmptyString(model.id);
}

function mapAcpModels(models: unknown): GeminiAcpModel[] {
  const available = asRecord(models)?.availableModels;
  if (!Array.isArray(available)) {
    return [];
  }
  const seen = new Set<string>();
  return available.flatMap((rawModel) => {
    const model = asRecord(rawModel);
    if (!model) {
      return [];
    }
    const id = acpModelId(model);
    if (!id || seen.has(id)) {
      return [];
    }
    seen.add(id);
    const description = asNonEmptyString(model.description);
    return [{
      id,
      ...(description ? { description } : {}),
    }];
  });
}

function mapAcpModes(modes: unknown): GeminiAcpMode[] {
  const available = asRecord(modes)?.availableModes;
  if (!Array.isArray(available)) {
    return [];
  }
  const seen = new Set<string>();
  return available.flatMap((rawMode) => {
    const mode = asRecord(rawMode);
    if (!mode) {
      return [];
    }
    const id = asNonEmptyString(mode.id);
    if (!id || seen.has(id)) {
      return [];
    }
    seen.add(id);
    const label = asNonEmptyString(mode.name) ?? asNonEmptyString(mode.label) ?? id;
    const description = asNonEmptyString(mode.description);
    return [{
      id,
      label,
      ...(description ? { description } : {}),
    }];
  });
}

class GeminiAcpProbeClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private closed = false;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly cwd: string) {}

  async start(timeoutMs: number): Promise<void> {
    const binary = await resolveConfiguredBinary("RAH_GEMINI_BINARY", "gemini");
    const child = spawn(binary, ["--acp"], {
      cwd: this.cwd,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-8192);
    });
    child.once("exit", (code, signal) => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      const suffix = this.stderrBuffer.trim() ? `: ${this.stderrBuffer.trim()}` : "";
      const error = new Error(
        `Gemini ACP probe exited with code ${code ?? "null"} signal ${signal ?? "null"}${suffix}`,
      );
      this.rejectAll(error);
    });
    child.once("error", (error) => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      this.rejectAll(error);
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    }, timeoutMs);
  }

  async createSession(timeoutMs: number): Promise<GeminiAcpProbeResult> {
    const response = await this.request<Record<string, unknown>>("session/new", {
      cwd: this.cwd,
      mcpServers: [],
    }, timeoutMs);
    const modelsField = asRecord(response.models);
    const modesField = asRecord(response.modes);
    const result: GeminiAcpProbeResult = {
      models: mapAcpModels(modelsField),
      modes: mapAcpModes(modesField),
    };
    const currentModelId = asNonEmptyString(modelsField?.currentModelId);
    const currentModeId = asNonEmptyString(modesField?.currentModeId);
    if (currentModelId) {
      result.currentModelId = currentModelId;
    }
    if (currentModeId) {
      result.currentModeId = currentModeId;
    }
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rejectAll(new Error("Gemini ACP probe closed"));
    const child = this.child;
    this.child = null;
    if (!child?.pid) {
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
        child.off("exit", finish);
        resolve();
      };
      const killTimer = setTimeout(() => {
        try {
          this.signalChild(child, "SIGKILL");
        } catch {
          // Best effort cleanup for a metadata probe.
        }
        finish();
      }, 1_000);
      child.once("exit", finish);
      try {
        this.signalChild(child, "SIGTERM");
      } catch {
        finish();
      }
    });
  }

  private async request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<T> {
    if (!this.child?.stdin || this.closed) {
      throw new Error("Gemini ACP probe is not running.");
    }
    const id = this.nextId++;
    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    const payload = `${JSON.stringify(message)}\n`;
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gemini ACP probe request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.child!.stdin!.write(payload, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      let message: JsonRpcIncoming;
      try {
        message = JSON.parse(line) as JsonRpcIncoming;
      } catch {
        continue;
      }
      if (!("id" in message) || typeof message.id !== "number") {
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        continue;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if ("error" in message && message.error) {
        const errorRecord = asRecord(message.error);
        pending.reject(new Error(asNonEmptyString(errorRecord?.message) ?? `${pending.method} failed`));
        continue;
      }
      pending.resolve(message.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (!pid) {
      return;
    }
    try {
      if (process.platform === "win32") {
        child.kill(signal);
        return;
      }
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }
}

export async function probeGeminiAcpCatalog(args: {
  cwd: string;
  timeoutMs: number;
}): Promise<GeminiAcpProbeResult> {
  const client = new GeminiAcpProbeClient(args.cwd);
  try {
    await client.start(args.timeoutMs);
    return await client.createSession(args.timeoutMs);
  } finally {
    await client.close();
  }
}
