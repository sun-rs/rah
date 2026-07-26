import { runBackgroundCommand } from "./background-command";

const MAX_HOST_CLIPBOARD_BYTES = 16 * 1024 * 1024;

async function runClipboardCommand(
  command: "pbcopy" | "pbpaste",
  input?: string,
  maxStdoutBytes = MAX_HOST_CLIPBOARD_BYTES,
): Promise<string> {
  const result = await runBackgroundCommand({
    command,
    label: `Host clipboard ${command}`,
    ...(input !== undefined ? { input } : {}),
    timeoutMs: 2_000,
    maxStdoutBytes,
    maxStderrBytes: 64 * 1024,
  });
  return result.stdout;
}

export async function writeHostClipboard(text: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Host clipboard fallback is only supported on macOS.");
  }
  const inputBytes = Buffer.byteLength(text, "utf8");
  if (inputBytes > MAX_HOST_CLIPBOARD_BYTES) {
    throw new Error("Host clipboard text exceeds the 16 MiB safety limit.");
  }

  await runClipboardCommand("pbcopy", text, 0);
  const pasted = await runClipboardCommand("pbpaste", undefined, inputBytes);
  if (pasted !== text) {
    throw new Error("Host clipboard verification failed.");
  }
}
