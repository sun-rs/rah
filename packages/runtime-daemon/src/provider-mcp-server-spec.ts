export interface ProviderMcpServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export const OPENCODE_MCP_TIMEOUT_MS = 300_000;

export function normalizeMcpServerName(name: string): string {
  return name
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "rah_council";
}

export function codexConfigOverridesForMcpServers(
  servers: readonly ProviderMcpServerSpec[] | undefined,
): Record<string, unknown> | undefined {
  if (!servers || servers.length === 0) {
    return undefined;
  }
  const overrides: Record<string, unknown> = {};
  for (const server of servers) {
    const name = normalizeMcpServerName(server.name);
    overrides[`mcp_servers.${name}.command`] = server.command;
    overrides[`mcp_servers.${name}.args`] = server.args ?? [];
    if (server.env && Object.keys(server.env).length > 0) {
      overrides[`mcp_servers.${name}.env`] = server.env;
    }
  }
  return overrides;
}

export function opencodeConfigForMcpServers(
  servers: readonly ProviderMcpServerSpec[] | undefined,
): Record<string, unknown> | undefined {
  if (!servers || servers.length === 0) {
    return undefined;
  }
  return {
    experimental: {
      mcp_timeout: OPENCODE_MCP_TIMEOUT_MS,
    },
    mcp: Object.fromEntries(
      servers.map((server) => [
        normalizeMcpServerName(server.name),
        {
          type: "local",
          command: [server.command, ...(server.args ?? [])],
          enabled: true,
          timeout: OPENCODE_MCP_TIMEOUT_MS,
          ...(server.env ? { environment: server.env } : {}),
        },
      ]),
    ),
  };
}

export function opencodeEnvForMcpServers(
  servers: readonly ProviderMcpServerSpec[] | undefined,
): Record<string, string> | undefined {
  const config = opencodeConfigForMcpServers(servers);
  if (!config) {
    return undefined;
  }
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  };
}

export type StartSessionMcpOptions = {
  extraMcpServers?: readonly ProviderMcpServerSpec[];
};

export function extraMcpServersFromRequest<T extends object>(
  request: T,
): readonly ProviderMcpServerSpec[] | undefined {
  const maybe = (request as T & StartSessionMcpOptions).extraMcpServers;
  return Array.isArray(maybe) ? maybe : undefined;
}
