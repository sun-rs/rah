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
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["content-length"], undefined);
    assert.deepEqual(JSON.parse(gunzipSync(response.body).toString("utf8")), payload);
  });
});

test("writeJson honors an explicit gzip opt-out", async () => {
  const payload = { text: "x".repeat(20_000) };
  await withJsonServer(payload, async (port) => {
    const response = await getRawJson(port, "gzip;q=0, identity");
    assert.equal(response.headers["content-encoding"], undefined);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers.vary, "accept-encoding");
    assert.equal(Number(response.headers["content-length"]), response.body.byteLength);
    assert.deepEqual(JSON.parse(response.body.toString("utf8")), payload);
  });
});

test("writeJson streams oversized identity responses without one giant buffer", async () => {
  const payload = {
    generatedAt: new Date("2026-07-25T00:00:00.000Z"),
    omitted: undefined,
    items: Array.from({ length: 8_000 }, (_, index) => ({
      index,
      text: `history-${index}-\"-${"内容".repeat(8)}`,
      optional: index % 2 === 0 ? undefined : true,
      array: [undefined, index, Number.NaN],
    })),
  };
  await withJsonServer(payload, async (port) => {
    const response = await getRawJson(port, "identity");
    assert.equal(response.headers["content-encoding"], undefined);
    assert.equal(response.headers["content-length"], undefined);
    assert.equal(response.headers.vary, "accept-encoding");
    assert.deepEqual(
      JSON.parse(response.body.toString("utf8")),
      JSON.parse(JSON.stringify(payload)),
    );
  });
});

test("writeJson yields the daemon event loop while streaming a large response", async () => {
  const payload = {
    items: Array.from({ length: 40_000 }, (_, index) => ({
      index,
      text: `turn-${index}-${"x".repeat(32)}`,
    })),
  };
  let eventLoopTurnObserved = false;
  const server = createServer((req, res) => {
    writeJson(req, res, 200, payload);
    setImmediate(() => {
      eventLoopTurnObserved = true;
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await getRawJson(address.port, "identity");
    assert.equal(eventLoopTurnObserved, true);
    assert.equal(JSON.parse(response.body.toString("utf8")).items.length, 40_000);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
