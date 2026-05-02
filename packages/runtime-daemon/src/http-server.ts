import { createServer } from "node:http";
import { RuntimeEngine } from "./runtime-engine";
import { createPostRoutes, handleHttpRequest } from "./http-server-routes";
import { attachWebSocketHandlers } from "./http-server-websocket";

export interface RahDaemon {
  port: number;
  close(): Promise<void>;
}

export async function startRahDaemon(options?: {
  port?: number;
  engine?: RuntimeEngine;
}): Promise<RahDaemon> {
  const port = options?.port ?? 43111;
  const engine = options?.engine ?? new RuntimeEngine();
  const postRoutes = createPostRoutes(engine);

  const server = createServer(async (req, res) => {
    await handleHttpRequest({ engine, postRoutes, req, res });
  });
  const websockets = attachWebSocketHandlers(server, engine);

  await new Promise<void>((resolve) => {
    server.listen(port, "0.0.0.0", () => resolve());
  });

  return {
    port,
    async close() {
      try {
        await engine.shutdown();
      } catch (error) {
        console.error("[rah] engine shutdown failed", error);
      }
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      } finally {
        websockets.close();
      }
    },
  };
}
