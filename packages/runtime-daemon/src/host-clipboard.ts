import { spawn } from "node:child_process";

function runClipboardCommand(command: "pbcopy" | "pbpaste", input?: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, [], { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Host clipboard ${command} timed out.`));
    }, 2_000);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code ?? "unknown"}.`));
    });
    if (input !== undefined) {
      if (!child.stdin) {
        clearTimeout(timeout);
        reject(new Error(`${command} stdin is unavailable.`));
        return;
      }
      child.stdin.end(input);
    }
  });
}

export async function writeHostClipboard(text: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Host clipboard fallback is only supported on macOS.");
  }

  await runClipboardCommand("pbcopy", text);
  const pasted = await runClipboardCommand("pbpaste");
  if (pasted !== text) {
    throw new Error("Host clipboard verification failed.");
  }
}
