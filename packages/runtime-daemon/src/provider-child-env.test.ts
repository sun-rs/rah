import { test } from "node:test";
import assert from "node:assert/strict";
import { providerChildEnv } from "./provider-child-env";

test("provider child env drops outer Codex runtime context but keeps Codex home", () => {
  const previous = {
    CODEX_CI: process.env.CODEX_CI,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    CODEX_TURN_ID: process.env.CODEX_TURN_ID,
    CODEX_SESSION_ID: process.env.CODEX_SESSION_ID,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  try {
    process.env.CODEX_CI = "1";
    process.env.CODEX_THREAD_ID = "outer-thread";
    process.env.CODEX_TURN_ID = "outer-turn";
    process.env.CODEX_SESSION_ID = "outer-session";
    process.env.CODEX_HOME = "/tmp/codex-home";

    const env = providerChildEnv({ RAH_NATIVE_SERVER_PROVIDER: "codex" });

    assert.equal(env.CODEX_CI, undefined);
    assert.equal(env.CODEX_THREAD_ID, undefined);
    assert.equal(env.CODEX_TURN_ID, undefined);
    assert.equal(env.CODEX_SESSION_ID, undefined);
    assert.equal(env.CODEX_HOME, "/tmp/codex-home");
    assert.equal(env.RAH_NATIVE_SERVER_PROVIDER, "codex");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
