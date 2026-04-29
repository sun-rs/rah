import { startRahDaemon } from "./http-server";

const requestedPort = process.env.RAH_PORT;
const port =
  requestedPort && Number.isFinite(Number.parseInt(requestedPort, 10))
    ? Number.parseInt(requestedPort, 10)
    : 43111;

const daemon = await startRahDaemon({ port });

console.log(`rah daemon listening on http://127.0.0.1:${daemon.port}`);

let shuttingDown = false;

const shutdown = async (exitCode: number) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  const forceExitTimer = setTimeout(() => {
    process.exit(exitCode);
  }, 2_000);
  forceExitTimer.unref?.();
  try {
    await daemon.close();
  } catch (error) {
    console.error("[rah] shutdown failed", error);
  } finally {
    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  }
};

process.on("unhandledRejection", (reason) => {
  console.error("[rah] unhandledRejection", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[rah] uncaughtException", error);
  void shutdown(1);
});

process.on("SIGINT", () => {
  void shutdown(0);
});
process.on("SIGTERM", () => {
  void shutdown(0);
});
