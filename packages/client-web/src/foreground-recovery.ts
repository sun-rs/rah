export type ForegroundRecoveryAttemptResult = {
  transportRecovered: boolean;
  conversationRecovered: boolean;
};

export type ForegroundRecoveryAttemptContext = {
  signal: AbortSignal;
};

export function foregroundClockWasSuspended(
  previousTickAt: number,
  currentTickAt: number,
  suspensionThresholdMs: number,
): boolean {
  return currentTickAt - previousTickAt >= suspensionThresholdMs;
}

type ForegroundRecoveryLoopOptions = {
  signal: AbortSignal;
  retryDelaysMs: readonly number[];
  runAttempt: (
    context: ForegroundRecoveryAttemptContext,
  ) => Promise<ForegroundRecoveryAttemptResult>;
  isVisible: () => boolean;
  onConversationRecovered?: () => void;
  waitForDelay?: (delayMs: number, signal: AbortSignal) => Promise<boolean>;
};

export function waitForAbortableDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (elapsed: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", handleAbort);
      resolve(elapsed);
    };
    const handleAbort = () => finish(false);
    timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

export async function runForegroundRecoveryLoop(
  options: ForegroundRecoveryLoopOptions,
): Promise<boolean> {
  const waitForDelay = options.waitForDelay ?? waitForAbortableDelay;
  let attempt = 0;

  while (!options.signal.aborted) {
    if (attempt > 0) {
      const delayMs = options.retryDelaysMs[
        Math.min(attempt - 1, options.retryDelaysMs.length - 1)
      ] ?? 12_000;
      if (!(await waitForDelay(delayMs, options.signal))) {
        return false;
      }
    }
    if (options.signal.aborted || !options.isVisible()) {
      return false;
    }

    const result = await options.runAttempt({ signal: options.signal });
    if (options.signal.aborted) {
      return false;
    }

    if (result.transportRecovered && result.conversationRecovered) {
      options.onConversationRecovered?.();
      return true;
    }
    attempt += 1;
  }

  return false;
}
