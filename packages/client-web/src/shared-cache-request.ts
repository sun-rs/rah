function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Lets a view stop waiting for shared cache work without cancelling the work.
 *
 * Cache fills outlive any one React view. The cache entry owns the underlying
 * request; a caller's AbortSignal only owns that caller's subscription to it.
 */
export function waitForSharedRequest<T>(
  request: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return request;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void request.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
