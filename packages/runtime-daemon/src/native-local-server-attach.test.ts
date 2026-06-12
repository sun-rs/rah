import assert from "node:assert/strict";
import test from "node:test";
import {
  nativeLocalServerAttachSpec,
  nativeLocalServerRuntimeDiagnostics,
} from "./native-local-server-attach";

test("nativeLocalServerAttachSpec builds provider-native client attach commands", () => {
  assert.deepEqual(
    nativeLocalServerAttachSpec({
      provider: "codex",
      providerSessionId: "thread-1",
      endpoint: "ws://127.0.0.1:12345/",
    }),
    {
      command: "codex",
      args: [
        "-c",
        "check_for_update_on_startup=false",
        "--remote",
        "ws://127.0.0.1:12345/",
        "resume",
        "thread-1",
      ],
      attachCommand: "codex -c check_for_update_on_startup=false --remote ws://127.0.0.1:12345/ resume thread-1",
    },
  );

  assert.deepEqual(
    nativeLocalServerAttachSpec({
      provider: "opencode",
      providerSessionId: "ses_1",
      endpoint: "http://127.0.0.1:4096",
    }),
    {
      command: "opencode",
      args: ["attach", "http://127.0.0.1:4096", "--session", "ses_1"],
      attachCommand: "opencode attach http://127.0.0.1:4096 --session ses_1",
    },
  );
});

test("nativeLocalServerAttachSpec refuses impossible or incomplete attach specs", () => {
  assert.equal(
    nativeLocalServerAttachSpec({
      provider: "codex",
      providerSessionId: "thread-1",
      endpoint: "stdio:codex app-server",
    }),
    null,
  );
  assert.equal(
    nativeLocalServerAttachSpec({
      provider: "claude",
      providerSessionId: "session-1",
      endpoint: "ws://127.0.0.1:1",
    }),
    null,
  );
  assert.equal(
    nativeLocalServerAttachSpec({
      provider: "opencode",
      endpoint: "http://127.0.0.1:4096",
    }),
    null,
  );
});

test("nativeLocalServerRuntimeDiagnostics includes attach command only when safe", () => {
  assert.deepEqual(
    nativeLocalServerRuntimeDiagnostics({
      provider: "codex",
      providerSessionId: "thread-1",
      endpoint: "ws://127.0.0.1:12345/",
      serverPid: 123,
      lastEventCursor: "thread:thread-1",
    }),
    {
      serverEndpoint: "ws://127.0.0.1:12345/",
      serverPid: 123,
      attachCommand: "codex -c check_for_update_on_startup=false --remote ws://127.0.0.1:12345/ resume thread-1",
      attachState: "ready",
      lastEventCursor: "thread:thread-1",
    },
  );

  assert.deepEqual(
    nativeLocalServerRuntimeDiagnostics({
      provider: "codex",
      endpoint: "stdio:codex app-server",
      attachState: "unavailable",
      lastEventCursor: "thread:pending",
    }),
    {
      serverEndpoint: "stdio:codex app-server",
      attachState: "unavailable",
      lastEventCursor: "thread:pending",
    },
  );
});
