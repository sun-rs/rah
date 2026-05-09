import assert from "node:assert/strict";
import test from "node:test";
import {
  runtimeDescriptorForLiveBackend,
  runtimeDescriptorForProviderCatalog,
  withManagedSessionRuntime,
  withProviderCatalogRuntime,
} from "./session-runtime-descriptor";
import type { ManagedSession, ProviderModelCatalog } from "@rah/runtime-protocol";

test("runtimeDescriptorForLiveBackend describes TUI mux fallback sessions", () => {
  const runtime = runtimeDescriptorForLiveBackend({ provider: "claude", liveBackend: "zellij_tui" });
  assert.equal(runtime.kind, "tui_mux_fallback");
  assert.equal(runtime.protocolStability, "tui_stdio");
  assert.equal(runtime.liveSource, "provider_history");
  assert.equal(runtime.tuiRole, "session_owner");
  assert.equal(runtime.structuredLiveEvents, false);
  assert.equal(runtime.tuiContinuity, true);
  assert.equal(runtime.features?.historyBackfill, "available");
  assert.equal(runtime.features?.tuiClientContinuity, "available");
  assert.equal(runtime.features?.structuredControl, "unsupported");
});

test("runtimeDescriptorForLiveBackend marks legacy structured sessions separately", () => {
  const runtime = runtimeDescriptorForLiveBackend({ provider: "codex", liveBackend: "structured" });
  assert.equal(runtime.kind, "legacy_structured");
  assert.equal(runtime.protocolStability, "project_native");
  assert.equal(runtime.liveSource, "rah_structured");
  assert.equal(runtime.tuiRole, "none");
  assert.equal(runtime.structuredLiveEvents, true);
  assert.equal(runtime.tuiContinuity, false);
  assert.equal(runtime.features?.structuredLiveEvents, "available");
  assert.equal(runtime.features?.structuredControl, "available");
  assert.equal(runtime.features?.historyBackfill, "unverified");
});

test("runtimeDescriptorForProviderCatalog advertises target provider runtime boundaries", () => {
  const codexRuntime = runtimeDescriptorForProviderCatalog("codex");
  const openCodeRuntime = runtimeDescriptorForProviderCatalog("opencode");
  assert.equal(codexRuntime.kind, "native_local_server");
  assert.equal(codexRuntime.structuredLiveEvents, true);
  assert.equal(codexRuntime.tuiContinuity, true);
  assert.equal(codexRuntime.tuiRole, "client_view");
  assert.equal(codexRuntime.features?.structuredLiveEvents, "available");
  assert.equal(codexRuntime.features?.structuredControl, "available");
  assert.equal(codexRuntime.features?.historyBackfill, "available");
  assert.equal(codexRuntime.features?.tuiClientContinuity, "available");
  assert.equal(codexRuntime.features?.crossClientSync, "available");
  assert.equal(codexRuntime.features?.runtimeConfig, "available");
  assert.equal(codexRuntime.features?.interrupt, "available");
  assert.equal(codexRuntime.features?.archiveLifecycle, "unverified");
  assert.equal(openCodeRuntime.kind, "native_local_server");
  assert.equal(openCodeRuntime.structuredLiveEvents, true);
  assert.equal(openCodeRuntime.tuiContinuity, true);
  assert.equal(openCodeRuntime.tuiRole, "client_view");
  assert.equal(openCodeRuntime.features?.tuiClientContinuity, "available");
  assert.equal(openCodeRuntime.features?.crossClientSync, "available");
  assert.equal(openCodeRuntime.features?.runtimeConfig, "available");
  assert.equal(openCodeRuntime.features?.interrupt, "available");
  assert.equal(openCodeRuntime.features?.archiveLifecycle, "available");
  assert.equal(runtimeDescriptorForProviderCatalog("claude").kind, "tui_mux_fallback");
  assert.equal(runtimeDescriptorForProviderCatalog("claude").features?.historyBackfill, "available");
});

test("runtime descriptor helpers preserve explicit runtime metadata", () => {
  const runtime = {
    kind: "stream_json_fifo",
    protocolStability: "official_stable",
    liveSource: "provider_server",
    tuiRole: "none",
    structuredLiveEvents: true,
    tuiContinuity: false,
  } as const;
  const catalog: ProviderModelCatalog = {
    provider: "claude",
    runtime,
    models: [],
    fetchedAt: "2026-05-09T00:00:00.000Z",
    source: "native",
  };
  const session = {
    id: "session-1",
    provider: "claude",
    launchSource: "web",
    liveBackend: "zellij_tui",
    cwd: "/tmp/rah",
    rootDir: "/tmp/rah",
    runtimeState: "idle",
    runtime,
    ptyId: "pty-1",
    capabilities: {
      liveAttach: true,
      structuredTimeline: true,
      nativeTui: true,
      rawPtyInput: false,
      chatMirror: true,
      structuredControl: false,
      livePermissions: false,
      contextUsage: false,
      resumeByProvider: true,
      listProviderSessions: true,
      renameSession: false,
      actions: {
        info: true,
        archive: true,
        delete: false,
        rename: "none",
      },
      steerInput: true,
      queuedInput: true,
      modelSwitch: false,
      planMode: false,
      subagents: false,
    },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  } satisfies ManagedSession;

  assert.equal(withProviderCatalogRuntime(catalog).runtime, runtime);
  assert.equal(withManagedSessionRuntime(session).runtime, runtime);
});
