import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { writeJson } from "./http-server-response";

async function withJsonServer(
  payload: unknown,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => writeJson(req, res, 200, payload));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function getRawJson(
  port: number,
  acceptEncoding: string,
): Promise<{ headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/",
        headers: { "accept-encoding": acceptEncoding },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.once("error", reject);
    req.end();
  });
}

test("writeJson streams large responses with gzip when accepted", async () => {
  const payload = { items: Array.from({ length: 500 }, (_, index) => ({ index, text: "turn preview" })) };
  await withJsonServer(payload, async (port) => {
    const response = await getRawJson(port, "br, gzip");
    assert.equal(response.headers["content-encoding"], "gzip");
    assert.equal(response.headers["content-length"], undefined);
    assert.deepEqual(JSON.parse(gunzipSync(response.body).toString("utf8")), payload);
  });
});

test("writeJson honors an explicit gzip opt-out", async () => {
  const payload = { text: "x".repeat(20_000) };
  await withJsonServer(payload, async (port) => {
    const response = await getRawJson(port, "gzip;q=0, identity");
    assert.equal(response.headers["content-encoding"], undefined);
    assert.equal(response.headers.vary, "accept-encoding");
    assert.equal(Number(response.headers["content-length"]), response.body.byteLength);
    assert.deepEqual(JSON.parse(response.body.toString("utf8")), payload);
  });
});
