import type {
  ManagedSession,
  ProviderKind,
  ProviderModelCatalog,
  SessionLiveBackend,
  SessionRuntimeCapabilityStatus,
  SessionRuntimeDescriptor,
} from "@rah/runtime-protocol";
import {
  conversationStateFromRuntimeState,
  defaultLiveBackendForProvider,
  isNativeLocalServerProvider,
  isTuiMuxFallbackProvider,
} from "@rah/runtime-protocol";

type RuntimeFeatureStatus = NonNullable<SessionRuntimeDescriptor["features"]>;

function runtimeFeatures(overrides: Partial<RuntimeFeatureStatus>): RuntimeFeatureStatus {
  const unsupported: SessionRuntimeCapabilityStatus = "unsupported";
  return {
    structuredLiveEvents: unsupported,
    structuredControl: unsupported,
    historyBackfill: unsupported,
    tuiClientContinuity: unsupported,
    crossClientSync: unsupported,
    prelaunchConfig: unsupported,
    runtimeConfig: unsupported,
    interrupt: unsupported,
    stopLifecycle: unsupported,
    ...overrides,
  };
}

function nativeLocalServerFeatures(provider: ProviderKind): RuntimeFeatureStatus {
  const supported = isNativeLocalServerProvider(provider);
  return runtimeFeatures({
    structuredLiveEvents: "available",
    structuredControl: "available",
    historyBackfill: "available",
    tuiClientContinuity: supported ? "available" : "unsupported",
    crossClientSync: supported ? "available" : "unsupported",
    prelaunchConfig: "available",
    runtimeConfig: supported ? "available" : "unverified",
    interrupt: supported ? "available" : "unverified",
    stopLifecycle: provider === "opencode" ? "available" : "unverified",
  });
}

function tuiMuxFallbackFeatures(): RuntimeFeatureStatus {
  return runtimeFeatures({
    historyBackfill: "available",
    tuiClientContinuity: "available",
    prelaunchConfig: "available",
    interrupt: "available",
    stopLifecycle: "available",
  });
}

function providerControlFeatures(): RuntimeFeatureStatus {
  return runtimeFeatures({
    structuredLiveEvents: "available",
    structuredControl: "available",
    historyBackfill: "unverified",
    prelaunchConfig: "available",
    runtimeConfig: "available",
    interrupt: "available",
    stopLifecycle: "available",
  });
}

export function runtimeDescriptorForStoredHistory(): SessionRuntimeDescriptor {
  return {
    kind: "stored_history",
    protocolStability: "project_native",
    liveSource: "provider_history",
    tuiRole: "none",
    structuredLiveEvents: false,
    tuiContinuity: false,
    features: runtimeFeatures({
      historyBackfill: "available",
    }),
  };
}

export function runtimeDescriptorForLiveBackend(args: {
  provider: ProviderKind;
  liveBackend?: SessionLiveBackend | undefined;
}): SessionRuntimeDescriptor {
  const liveBackend = args.liveBackend ?? defaultLiveBackendForProvider(args.provider);
  if (liveBackend === "native_local_server") {
    const providerTuiClientAvailable = isNativeLocalServerProvider(args.provider);
    return {
      kind: "native_local_server",
      protocolStability: "project_native",
      liveSource: "provider_server",
      tuiRole: providerTuiClientAvailable ? "client_view" : "none",
      structuredLiveEvents: true,
      tuiContinuity: providerTuiClientAvailable,
      features: nativeLocalServerFeatures(args.provider),
    };
  }

  if (liveBackend === "tui_mux" || liveBackend === "native_tui") {
    return {
      kind: "tui_mux_fallback",
      protocolStability: "tui_stdio",
      liveSource: "provider_history",
      tuiRole: "session_owner",
      structuredLiveEvents: false,
      tuiContinuity: true,
      features: tuiMuxFallbackFeatures(),
    };
  }

  return {
    kind: "provider_control",
    protocolStability: "project_native",
    liveSource: "rah_control",
    tuiRole: "none",
    structuredLiveEvents: true,
    tuiContinuity: false,
    features: providerControlFeatures(),
  };
}

export function runtimeDescriptorForProviderCatalog(
  provider: ProviderKind,
): SessionRuntimeDescriptor {
  if (isTuiMuxFallbackProvider(provider)) {
    return {
      kind: "tui_mux_fallback",
      protocolStability: "tui_stdio",
      liveSource: "provider_history",
      tuiRole: "session_owner",
      structuredLiveEvents: false,
      tuiContinuity: true,
      features: tuiMuxFallbackFeatures(),
    };
  }
  if (isNativeLocalServerProvider(provider)) {
    const providerTuiClientAvailable = isNativeLocalServerProvider(provider);
    return {
      kind: "native_local_server",
      protocolStability: "project_native",
      liveSource: "provider_server",
      tuiRole: providerTuiClientAvailable ? "client_view" : "none",
      structuredLiveEvents: true,
      tuiContinuity: providerTuiClientAvailable,
      features: nativeLocalServerFeatures(provider),
    };
  }
  return runtimeDescriptorForLiveBackend({ provider });
}

export function withProviderCatalogRuntime<TCatalog extends ProviderModelCatalog>(
  catalog: TCatalog,
): TCatalog {
  return {
    ...catalog,
    runtime: catalog.runtime ?? runtimeDescriptorForProviderCatalog(catalog.provider),
  };
}

export function withManagedSessionRuntime<TSession extends ManagedSession>(
  session: TSession,
): TSession {
  const conversationState =
    session.status && session.phase
      ? { status: session.status, phase: session.phase }
      : conversationStateFromRuntimeState(session.runtimeState);
  return {
    ...session,
    ...conversationState,
    runtime:
      session.runtime ??
      runtimeDescriptorForLiveBackend({
        provider: session.provider,
        liveBackend: session.liveBackend,
      }),
  };
}
