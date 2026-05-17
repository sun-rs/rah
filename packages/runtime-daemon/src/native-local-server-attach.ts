import type {
  ProviderKind,
  SessionRuntimeDiagnostics,
} from "@rah/runtime-protocol";

export type NativeLocalServerAttachSpec = {
  command: string;
  args: string[];
  attachCommand: string;
};

function providerBinary(provider: ProviderKind): string | null {
  if (provider === "codex") {
    return process.env.RAH_CODEX_BINARY || "codex";
  }
  if (provider === "opencode") {
    return process.env.RAH_OPENCODE_BINARY || "opencode";
  }
  return null;
}

export function nativeLocalServerAttachSpec(args: {
  provider: ProviderKind;
  providerSessionId?: string | undefined;
  endpoint?: string | undefined;
}): NativeLocalServerAttachSpec | null {
  const providerSessionId = args.providerSessionId?.trim();
  const endpoint = args.endpoint?.trim();
  if (!providerSessionId || !endpoint) {
    return null;
  }

  const command = providerBinary(args.provider);
  if (!command) {
    return null;
  }

  if (args.provider === "codex") {
    if (!/^wss?:\/\//.test(endpoint)) {
      return null;
    }
    const attachArgs = ["--remote", endpoint, "resume", providerSessionId];
    return {
      command,
      args: attachArgs,
      attachCommand: `${command} ${attachArgs.join(" ")}`,
    };
  }

  if (args.provider === "opencode") {
    const attachArgs = ["attach", endpoint, "--session", providerSessionId];
    return {
      command,
      args: attachArgs,
      attachCommand: `${command} ${attachArgs.join(" ")}`,
    };
  }

  return null;
}

export function nativeLocalServerRuntimeDiagnostics(args: {
  provider: ProviderKind;
  providerSessionId?: string | undefined;
  endpoint: string;
  serverPid?: number | undefined;
  lastEventCursor: string;
  attachState?: SessionRuntimeDiagnostics["attachState"] | undefined;
}): SessionRuntimeDiagnostics {
  const attach = nativeLocalServerAttachSpec({
    provider: args.provider,
    providerSessionId: args.providerSessionId,
    endpoint: args.endpoint,
  });
  return {
    serverEndpoint: args.endpoint,
    ...(args.serverPid !== undefined ? { serverPid: args.serverPid } : {}),
    ...(attach ? { attachCommand: attach.attachCommand } : {}),
    attachState: args.attachState ?? (attach ? "ready" : "unavailable"),
    lastEventCursor: args.lastEventCursor,
  };
}

