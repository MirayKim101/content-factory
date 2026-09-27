export interface AbortDeadline {
  signal: AbortSignal;
  dispose(): void;
}

export function createAbortDeadline(
  parent: AbortSignal,
  timeoutMs: number,
  timeoutCode: string,
): AbortDeadline {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("ABORT_DEADLINE_INVALID");
  const controller = new AbortController();
  const inheritAbort = () => controller.abort(parent.reason);
  if (parent.aborted) inheritAbort();
  else parent.addEventListener("abort", inheritAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error(timeoutCode));
  }, timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", inheritAbort);
    },
  };
}
