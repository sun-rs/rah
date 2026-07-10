import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { copyTextToClipboard } from "./clipboard";

const originalFetch = globalThis.fetch;
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
  } else {
    delete (globalThis as typeof globalThis & { navigator?: Navigator }).navigator;
  }
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    delete (globalThis as typeof globalThis & { window?: Window }).window;
  }
});

test("copyTextToClipboard uses browser clipboard when available", async () => {
  let copied = "";
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (value: string) => {
          copied = value;
        },
      },
    },
  });

  assert.equal(await copyTextToClipboard("hello"), "copied");
  assert.equal(copied, "hello");
});

test("copyTextToClipboard falls back to host clipboard without browser clipboard", async () => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {},
  });
  let requestBody: unknown = null;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = init?.body ? JSON.parse(String(init.body)) : null;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  assert.equal(await copyTextToClipboard("from remote browser"), "copied");
  assert.deepEqual(requestBody, { text: "from remote browser" });
});

test("copyTextToClipboard does not report host clipboard success for remote browsers", async () => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {},
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        hostname: "mac-studio.tail899ffc.ts.net",
      },
    },
  });
  let hostClipboardCalls = 0;
  globalThis.fetch = (async () => {
    hostClipboardCalls += 1;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  assert.equal(await copyTextToClipboard("remote copy"), "failed");
  assert.equal(hostClipboardCalls, 0);
});
