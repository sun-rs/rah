export const DEFAULT_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS = 1_000;
export const DEFAULT_NATIVE_TUI_MIRROR_INTERVAL_MS = 1_000;
export const DEFAULT_NATIVE_TUI_BINDING_WARN_AFTER_MS = 30_000;
export const DEFAULT_NATIVE_TUI_MIRROR_WARN_AFTER_MS = 30_000;

type Env = Record<string, string | undefined>;

export function positiveIntegerEnv(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function nativeTuiBindingProbeIntervalMs(env: Env = process.env): number {
  return positiveIntegerEnv(
    env,
    "RAH_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS",
    DEFAULT_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS,
  );
}

export function nativeTuiMirrorIntervalMs(env: Env = process.env): number {
  return positiveIntegerEnv(
    env,
    "RAH_NATIVE_TUI_MIRROR_INTERVAL_MS",
    DEFAULT_NATIVE_TUI_MIRROR_INTERVAL_MS,
  );
}

export function nativeTuiBindingWarnAfterMs(env: Env = process.env): number {
  return positiveIntegerEnv(
    env,
    "RAH_NATIVE_TUI_BINDING_WARN_AFTER_MS",
    DEFAULT_NATIVE_TUI_BINDING_WARN_AFTER_MS,
  );
}

export function nativeTuiMirrorWarnAfterMs(env: Env = process.env): number {
  return positiveIntegerEnv(
    env,
    "RAH_NATIVE_TUI_MIRROR_WARN_AFTER_MS",
    DEFAULT_NATIVE_TUI_MIRROR_WARN_AFTER_MS,
  );
}
