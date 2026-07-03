export function normalizeRolloutPercent(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.floor(number)));
}
