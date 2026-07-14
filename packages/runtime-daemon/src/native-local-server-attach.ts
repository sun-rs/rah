import type {
  ProviderKind,
  SessionRuntimeDiagnostics,
} from "@rah/runtime-protocol";
import { providerBinaryArgv } from "./provider-binary-utils";

export type NativeLocalServerAttachSpec = {
  command: string;
  args: string[];
  attachCommand: string;
};

const CODEX_TUI_CLIENT_CONFIG_ARGS = [
  "-c",
  "check_for_update_on_startup=false",
] as const;

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
  const [runtimeCommand, ...runtimeArgs] = providerBinaryArgv(command);
  if (!runtimeCommand) {
    return null;
  }

  if (args.provider === "codex") {
    if (!/^wss?:\/\//.test(endpoint)) {
      return null;
    }
    const attachArgs = [
      ...runtimeArgs,
      ...CODEX_TUI_CLIENT_CONFIG_ARGS,
      "--remote",
      endpoint,
      "resume",
      providerSessionId,
    ];
    return {
      command: runtimeCommand,
      args: attachArgs,
      attachCommand: `${runtimeCommand} ${attachArgs.join(" ")}`,
    };
  }

  if (args.provider === "opencode") {
    const attachArgs = [...runtimeArgs, "attach", endpoint, "--session", providerSessionId];
    return {
      command: runtimeCommand,
      args: attachArgs,
      attachCommand: `${runtimeCommand} ${attachArgs.join(" ")}`,
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
