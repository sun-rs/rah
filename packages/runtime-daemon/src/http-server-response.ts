import type { IncomingMessage, ServerResponse } from "node:http";
import { applyCorsHeaders } from "./http-server-cors";

export type JsonHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  match: RegExpExecArray,
  body: unknown,
) => Promise<void>;

export function requestErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("Cross-origin requests are not allowed.") ||
    message.includes("Missing required RAH client header.") ||
    message.includes("Workspace directory is not registered.") ||
    message.includes("Requested scope root is outside the session workspace boundary.")
  ) {
    return 403;
  }
  if (
    message.includes("is required") ||
    message.includes("Bad Request") ||
    message.includes("Path is not a file.") ||
    message.includes("Workspace directory is required.")
  ) {
    return 400;
  }
  if (message.startsWith("Unknown session ")) {
    return 404;
  }
  return 500;
}

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

export function writeJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  applyCorsHeaders(req, res);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function writeText(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: string,
): void {
  applyCorsHeaders(req, res);
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}
