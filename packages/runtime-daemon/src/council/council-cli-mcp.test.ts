import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function repoRoot(): string {
  return fileURLToPath(new URL("../../../..", import.meta.url));
}

function collectLines(stream: NodeJS.ReadableStream, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let buffer = "";
    const timeout = setTimeout(() => reject(new Error("timed out waiting for MCP output")), 5_000);
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          lines.push(line);
        }
        if (lines.length >= count) {
          clearTimeout(timeout);
          resolve(lines);
        }
      }
    });
    stream.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

test("rah council-mcp speaks minimal MCP JSON-RPC over stdio", async () => {
  const received: unknown[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/council/mcp") {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { tool?: string };
      received.push(parsed);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result: { echoedTool: parsed.tool } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const child = spawn(process.execPath, [
    path.join(repoRoot(), "bin/rah.mjs"),
    "council-mcp",
    "--room",
    "room-1",
    "--actor",
    "agent-1",
    "--daemon-url",
    `http://127.0.0.1:${address.port}`,
  ], {
    cwd: repoRoot(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    const linesPromise = collectLines(child.stdout, 3);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "channel_post", arguments: { content: "hello" } } })}\n`);
    child.stdin.end();

    const lines = await linesPromise;
    const responses = lines.map((line) => JSON.parse(line) as {
      jsonrpc: string;
      id: number;
      result?: { tools?: Array<{ name: string }>; content?: Array<{ type: string; text: string }>; structuredContent?: unknown };
    });
    assert.equal(responses[0]!.jsonrpc, "2.0");
    assert.equal(responses[0]!.id, 1);
    assert.equal(responses[1]!.result?.tools?.some((tool) => tool.name === "channel_post"), true);
    assert.equal(responses[2]!.result?.content?.[0]?.type, "text");
    assert.deepEqual(responses[2]!.result?.structuredContent, { echoedTool: "channel_post" });
    assert.equal((received[0] as { roomId?: string }).roomId, "room-1");
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
