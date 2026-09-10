export function deadlineSignal(parentSignal, timeoutMs) {
  const timeout = Number(timeoutMs);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("timeoutMs must be a positive number");
  const timeoutSignal = AbortSignal.timeout(Math.floor(timeout));
  return parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
}
