import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { applyCorsHeaders, validateApiRequest } from "./http-server-cors";

function request(method: string, headers: Record<string, string>): IncomingMessage {
  return { method, headers } as IncomingMessage;
}

test("CORS preflight responses allow DELETE", () => {
  const headers = new Map<string, string | number | readonly string[]>();
  const response = {
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
  } as ServerResponse;

  applyCorsHeaders(
    request("OPTIONS", {
      origin: "http://127.0.0.1:5173",
      host: "127.0.0.1:5173",
    }),
    response,
  );

  assert.match(String(headers.get("access-control-allow-methods")), /DELETE/);
});

test("DELETE API mutations require the web client header when Origin is present", () => {
  const denied = validateApiRequest(
    request("DELETE", {
      origin: "http://127.0.0.1:43111",
      host: "127.0.0.1:43111",
    }),
    "/api/providers/codex/manual-models/gpt-5.6",
  );
  const allowed = validateApiRequest(
    request("DELETE", {
      origin: "http://127.0.0.1:43111",
      host: "127.0.0.1:43111",
      "x-rah-client": "web",
    }),
    "/api/providers/codex/manual-models/gpt-5.6",
  );

  assert.equal(denied, "Missing required RAH client header.");
  assert.equal(allowed, null);
});
