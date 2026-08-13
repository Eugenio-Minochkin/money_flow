const CLIENT_PHASES = [
  "telegram_sdk",
  "telegram_sdk_resource",
  "app_bootstrap",
  "dashboard_request",
  "dashboard_render",
  "dashboard_total",
  "navigation_ttfb",
  "app_entry_resource",
  "styles_resource"
];

export function recordClientStartupTiming(input, {
  logger = console,
  slowThresholdMs = 1_000
} = {}) {
  const timings = sanitizeClientStartupTimings(input);
  if (!timings) return null;
  if (timings.dashboard_total >= slowThresholdMs) {
    logger.warn("[startup] slow client", { timings });
  }
  return timings;
}

function sanitizeClientStartupTimings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const timings = {};
  for (const phase of CLIENT_PHASES) {
    const value = input[phase];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 120_000) continue;
    timings[phase] = Math.round(value * 10) / 10;
  }
  return typeof timings.dashboard_total === "number" ? timings : null;
}
