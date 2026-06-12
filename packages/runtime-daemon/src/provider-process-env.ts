const VOLATILE_CODEX_PARENT_ENV_KEYS = [
  "CODEX_CI",
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
  "CODEX_TURN_ID",
] as const;

export function removeVolatileProviderParentEnv(env: Record<string, string | undefined>): void {
  for (const key of VOLATILE_CODEX_PARENT_ENV_KEYS) {
    delete env[key];
  }
}

export function providerProcessEnv(extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(extraEnv ?? {}) };
  removeVolatileProviderParentEnv(env);
  return env;
}
