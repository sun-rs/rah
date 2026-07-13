import type { CodexAppServerRpcClient } from "./codex-live-rpc";

export async function requestCodexThreadResumeWithoutTranscript(args: {
  client: CodexAppServerRpcClient;
  params: Record<string, unknown> & { threadId: string };
  timeoutMs: number;
}): Promise<unknown> {
  return await args.client.request(
    "thread/resume",
    { ...args.params, excludeTurns: true },
    args.timeoutMs,
  );
}
