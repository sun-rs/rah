import { spawn } from "node:child_process";
import { resolveConfiguredBinary } from "./provider-binary-utils";
import { CodexJsonRpcClient } from "./codex-live-rpc";

export { CodexJsonRpcClient } from "./codex-live-rpc";

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

export async function createCodexAppServerClient(): Promise<CodexJsonRpcClient> {
  const binary = await resolveCodexBinary();
  const child = spawn(binary, ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
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
