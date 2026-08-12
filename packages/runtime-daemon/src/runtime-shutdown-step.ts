const SHUTDOWN_STEP_TIMEOUT_MS = 8_000;

export async function runShutdownStep(
  label: string,
  task: () => Promise<unknown> | unknown,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(task),
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Shutdown step timed out after ${SHUTDOWN_STEP_TIMEOUT_MS}ms.`));
        }, SHUTDOWN_STEP_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
  } catch (error) {
    console.error("[rah] shutdown step failed", { step: label, error });
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
