import type { CodexAppServerRpcClient } from "./codex-live-rpc";

function excludeTurnsIsUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /excludeTurns|exclude_turns/i.test(message) ||
    /unknown field|unexpected field|invalid params.*experimental/i.test(message)
  );
}

export async function requestCodexThreadResumeWithoutTranscript(args: {
  client: CodexAppServerRpcClient;
  params: Record<string, unknown> & { threadId: string };
  timeoutMs: number;
}): Promise<unknown> {
  try {
    return await args.client.request(
      "thread/resume",
      { ...args.params, excludeTurns: true },
      args.timeoutMs,
    );
  } catch (error) {
    if (!excludeTurnsIsUnsupported(error)) {
      throw error;
    }
    return await args.client.request("thread/resume", args.params, args.timeoutMs);
  }
}
