const PROVIDER_CONTEXT_ENV_KEYS = [
  "CODEX_CI",
  "CODEX_THREAD_ID",
  "CODEX_TURN_ID",
  "CODEX_SESSION_ID",
] as const;

export function providerChildEnv(extraEnv?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  for (const key of PROVIDER_CONTEXT_ENV_KEYS) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(extraEnv ?? {})) {
    env[key] = value;
  }
  return env;
}
