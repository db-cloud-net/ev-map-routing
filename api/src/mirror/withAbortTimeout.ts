export function withAbortTimeout(args: {
  parentSignal?: AbortSignal;
  timeoutMs: number;
}): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const { parentSignal, timeoutMs } = args;

  const onAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", onAbort, { once: true });
  }

  const t = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(t);
      if (parentSignal) parentSignal.removeEventListener("abort", onAbort);
    }
  };
}

