import { startRahDaemon } from "./http-server";

const requestedPort = process.env.RAH_PORT;
const port =
  requestedPort && Number.isFinite(Number.parseInt(requestedPort, 10))
    ? Number.parseInt(requestedPort, 10)
    : 43111;

const daemon = await startRahDaemon({ port });

console.log(`rah daemon listening on http://127.0.0.1:${daemon.port}`);

process.on("unhandledRejection", (reason) => {
  console.error("[rah] unhandledRejection", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[rah] uncaughtException", error);
});

const shutdown = async () => {
  await daemon.close();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
