import assert from "node:assert/strict";
import test from "node:test";
import {
  codexConfigOverridesForMcpServers,
  geminiSettingsForMcpServers,
  normalizeMcpServerName,
  opencodeConfigForMcpServers,
  opencodeEnvForMcpServers,
} from "./provider-mcp-server-spec";

test("provider MCP helpers translate Council MCP servers into provider startup config", () => {
  const servers = [
    {
      name: "rah council",
      command: "/usr/bin/node",
      args: ["/repo/bin/rah.mjs", "council-mcp"],
      env: { RAH_DAEMON_URL: "http://127.0.0.1:43111" },
    },
  ];

  assert.deepEqual(codexConfigOverridesForMcpServers(servers), {
    "mcp_servers.rah_council.command": "/usr/bin/node",
    "mcp_servers.rah_council.args": ["/repo/bin/rah.mjs", "council-mcp"],
    "mcp_servers.rah_council.env": { RAH_DAEMON_URL: "http://127.0.0.1:43111" },
  });

  assert.deepEqual(opencodeConfigForMcpServers(servers), {
    experimental: {
      mcp_timeout: 300_000,
    },
    mcp: {
      rah_council: {
        type: "local",
        command: ["/usr/bin/node", "/repo/bin/rah.mjs", "council-mcp"],
        enabled: true,
        timeout: 300_000,
        environment: { RAH_DAEMON_URL: "http://127.0.0.1:43111" },
      },
    },
  });

  assert.deepEqual(geminiSettingsForMcpServers(servers), {
    mcpServers: {
      rah_council: {
        command: "/usr/bin/node",
        args: ["/repo/bin/rah.mjs", "council-mcp"],
        env: { RAH_DAEMON_URL: "http://127.0.0.1:43111" },
        trust: true,
      },
    },
  });

  const env = opencodeEnvForMcpServers(servers);
  assert.ok(env?.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT), opencodeConfigForMcpServers(servers));
});

test("normalizes MCP server names for provider-specific tool prefixes", () => {
  assert.equal(normalizeMcpServerName("rah council"), "rah_council");
});
