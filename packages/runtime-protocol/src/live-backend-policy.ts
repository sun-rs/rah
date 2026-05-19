import type { ProviderKind, SessionLiveBackend } from "./session";

export type NativeLocalServerProvider = "codex" | "opencode";
export type TuiMuxFallbackProvider = "claude" | "gemini";
export type CoreLiveProvider = NativeLocalServerProvider | TuiMuxFallbackProvider;

export const NATIVE_LOCAL_SERVER_PROVIDERS = [
  "codex",
  "opencode",
] as const satisfies readonly ProviderKind[];

export const TUI_MUX_FALLBACK_PROVIDERS = [
  "claude",
  "gemini",
] as const satisfies readonly ProviderKind[];

export const CORE_LIVE_PROVIDERS = [
  ...NATIVE_LOCAL_SERVER_PROVIDERS,
  ...TUI_MUX_FALLBACK_PROVIDERS,
] as const satisfies readonly ProviderKind[];

export function isNativeLocalServerProvider(
  provider: string,
): provider is NativeLocalServerProvider {
  return (NATIVE_LOCAL_SERVER_PROVIDERS as readonly string[]).includes(provider);
}

export function isTuiMuxFallbackProvider(
  provider: string,
): provider is TuiMuxFallbackProvider {
  return (TUI_MUX_FALLBACK_PROVIDERS as readonly string[]).includes(provider);
}

export function isCoreLiveProvider(provider: string): provider is CoreLiveProvider {
  return (CORE_LIVE_PROVIDERS as readonly string[]).includes(provider);
}

export function defaultLiveBackendForProvider(
  provider: string,
): SessionLiveBackend | undefined {
  if (isNativeLocalServerProvider(provider)) {
    return "native_local_server";
  }
  if (isTuiMuxFallbackProvider(provider)) {
    return "tui_mux";
  }
  return undefined;
}

export function liveBackendSupportedByProvider(args: {
  provider: string;
  liveBackend: SessionLiveBackend;
}): boolean {
  if (args.liveBackend === "native_local_server") {
    return isNativeLocalServerProvider(args.provider);
  }
  if (args.liveBackend === "tui_mux") {
    return isTuiMuxFallbackProvider(args.provider);
  }
  if (args.liveBackend === "native_tui") {
    return isCoreLiveProvider(args.provider);
  }
  return args.liveBackend === "structured";
}
