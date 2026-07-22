import type { CodexAppServerRpcClient } from "./codex-live-rpc";

export async function requestCodexThreadForkWithoutTranscript(args: {
  client: CodexAppServerRpcClient;
  params: Record<string, unknown> & { threadId: string };
  timeoutMs: number;
}): Promise<unknown> {
  return await args.client.request(
    "thread/fork",
    { ...args.params, excludeTurns: true },
    args.timeoutMs,
  );
}
