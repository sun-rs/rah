import { setTimeout as delay } from "node:timers/promises";
import { serveBackgroundIpcTask } from "./background-ipc-task";

type Request =
  | { kind: "echo"; value: string }
  | { kind: "large"; bytes: number }
  | { kind: "delay"; milliseconds: number };

type Response =
  | { ok: true; value: string }
  | { ok: false; error: string };

serveBackgroundIpcTask<Request, Response>({
  label: "Background IPC test worker",
  async handle(request) {
    if (request.kind === "echo") {
      return { ok: true, value: request.value };
    }
    if (request.kind === "large") {
      return { ok: true, value: "x".repeat(request.bytes) };
    }
    await delay(request.milliseconds);
    return { ok: true, value: "finished" };
  },
  onError: (error) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }),
  maxResponseBytes: 1024,
});
