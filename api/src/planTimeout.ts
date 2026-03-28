/**
 * Enforce a hard wall-clock budget on `planTrip` so long external calls cannot hang `/plan` indefinitely.
 * Implemented with async/await so AsyncLocalStorage (provider call metrics) propagates reliably on Node.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
