import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveRuntimeCompatibilityDescriptor,
  browserRuntimeCompatibilityMutePersistence,
  isRuntimeCompatibilityMutedToday,
  muteRuntimeCompatibilityForToday,
  RUNTIME_COMPATIBILITY_MUTED_DATE_KEY,
  RUNTIME_COMPATIBILITY_MUTED_DATE_COOKIE,
  resetVolatileRuntimeCompatibilityMuteForTests,
  runtimeCompatibilityMuteCookie,
  runtimeCompatibilityMuteDateFromCookie,
  runtimeCompatibilityLocalDate,
} from "./runtime-compatibility";

test.beforeEach(() => {
  resetVolatileRuntimeCompatibilityMuteForTests();
});

test("reports only exact Web and daemon generation mismatches", () => {
  assert.equal(
    deriveRuntimeCompatibilityDescriptor("same", {
      pid: 12,
      webBuildId: "same",
    }),
    null,
  );
  assert.equal(
    deriveRuntimeCompatibilityDescriptor("", {
      pid: 12,
      webBuildId: "daemon",
    }),
    null,
  );
  assert.deepEqual(
    deriveRuntimeCompatibilityDescriptor("browser", { pid: 12 }),
    {
      title: "Restart RAH to update",
      body: "Restart it on the host, then refresh this page.",
    },
  );

  const mismatch = deriveRuntimeCompatibilityDescriptor(
    "browser-generation",
    {
      pid: 42,
      webBuildId: "daemon-generation",
    },
  );
  assert.equal(mismatch?.title, "Restart RAH to update");
  assert.equal(
    mismatch?.body,
    "Restart it on the host, then refresh this page.",
  );
  assert.equal(mismatch?.primaryLabel, undefined);
  assert.equal(mismatch?.primaryAction, undefined);
});

test("mutes compatibility notices for the current local calendar day", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const today = new Date(2026, 7, 13, 23, 59);
  const tomorrow = new Date(2026, 7, 14, 0, 1);

  assert.equal(runtimeCompatibilityLocalDate(today), "2026-08-13");
  const persistence = { storages: [storage] };
  assert.equal(isRuntimeCompatibilityMutedToday(persistence, today), false);
  muteRuntimeCompatibilityForToday(persistence, today);
  assert.equal(values.get(RUNTIME_COMPATIBILITY_MUTED_DATE_KEY), "2026-08-13");
  assert.equal(isRuntimeCompatibilityMutedToday(persistence, today), true);
  assert.equal(isRuntimeCompatibilityMutedToday(persistence, tomorrow), false);
});

test("falls back when iOS rejects one persistence surface", () => {
  const sessionValues = new Map<string, string>();
  const rejectedStorage = {
    getItem: () => {
      throw new Error("storage unavailable");
    },
    setItem: () => {
      throw new Error("storage unavailable");
    },
  };
  const sessionStorage = {
    getItem: (key: string) => sessionValues.get(key) ?? null,
    setItem: (key: string, value: string) => sessionValues.set(key, value),
  };
  const writtenCookies: string[] = [];
  const today = new Date(2026, 7, 13, 12, 0);

  muteRuntimeCompatibilityForToday(
    {
      storages: [rejectedStorage, sessionStorage],
      writeCookie: (cookie) => writtenCookies.push(cookie),
    },
    today,
  );

  assert.equal(
    sessionValues.get(RUNTIME_COMPATIBILITY_MUTED_DATE_KEY),
    "2026-08-13",
  );
  assert.match(
    writtenCookies[0] ?? "",
    new RegExp(`^${RUNTIME_COMPATIBILITY_MUTED_DATE_COOKIE}=2026-08-13;`),
  );
  resetVolatileRuntimeCompatibilityMuteForTests();
  assert.equal(
    isRuntimeCompatibilityMutedToday(
      { storages: [rejectedStorage, sessionStorage] },
      today,
    ),
    true,
  );
});

test("uses an end-of-local-day cookie as the reload fallback", () => {
  const today = new Date(2026, 7, 13, 23, 59, 30);
  const cookie = runtimeCompatibilityMuteCookie(today);
  assert.equal(
    runtimeCompatibilityMuteDateFromCookie(
      `unrelated=value; ${RUNTIME_COMPATIBILITY_MUTED_DATE_COOKIE}=2026-08-13`,
    ),
    "2026-08-13",
  );
  assert.match(cookie, /Max-Age=30;/);
  assert.equal(
    isRuntimeCompatibilityMutedToday(
      { cookieHeader: `${RUNTIME_COMPATIBILITY_MUTED_DATE_COOKIE}=2026-08-13` },
      today,
    ),
    true,
  );
});

test("reads browser persistence without exposing storage getter failures", () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      get localStorage() {
        throw new Error("blocked");
      },
      sessionStorage: {
        getItem: () => null,
        setItem: () => undefined,
      },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "cookie=value" },
  });
  try {
    const persistence = browserRuntimeCompatibilityMutePersistence();
    assert.equal(persistence.storages?.length, 2);
    assert.equal(persistence.cookieHeader, "cookie=value");
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
  }
});
