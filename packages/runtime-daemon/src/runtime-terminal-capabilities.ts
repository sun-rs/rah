import type { ProviderKind, SessionCapabilities } from "@rah/runtime-protocol";

export function buildTerminalWrapperSessionCapabilities(
  provider: ProviderKind,
): Partial<SessionCapabilities> {
  return {
    livePermissions: provider !== "claude",
    renameSession: false,
    actions: {
      info: true,
      archive: true,
      delete: false,
      rename: "none",
    },
    steerInput: true,
    queuedInput: true,
  };
}

export function buildNativeTuiSessionCapabilities(
  provider: ProviderKind,
): Partial<SessionCapabilities> {
  const hasStructuredMirror =
    provider === "codex" ||
    provider === "claude" ||
    provider === "opencode";
  return {
    liveAttach: true,
    structuredTimeline: hasStructuredMirror,
    nativeTui: true,
    rawPtyInput: true,
    chatMirror: hasStructuredMirror,
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
  };
}

export function buildStoppedNativeTuiSessionCapabilities(
  provider: ProviderKind,
): Partial<SessionCapabilities> {
  const capabilities = buildNativeTuiSessionCapabilities(provider);
  return {
    ...capabilities,
    liveAttach: false,
    rawPtyInput: false,
    chatMirror: false,
    steerInput: false,
    queuedInput: false,
  };
}

export function buildZellijTuiSessionCapabilities(
  provider: ProviderKind,
): Partial<SessionCapabilities> {
  return {
    ...buildNativeTuiSessionCapabilities(provider),
    // The browser still talks through RAH's PTY websocket contract, but the
    // actual terminal is held by zellij rather than the in-process PTY runtime.
    rawPtyInput: false,
  };
}
