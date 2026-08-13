const PHASES = new Set([
  "auth",
  "user_upsert",
  "report_lookup",
  "analytics",
  "timezone_sync",
  "repository_dashboard",
  "reserve",
  "lock",
  "reserve_reads",
  "budget",
  "totals",
  "baseline",
  "planned",
  "paid_planned",
  "snapshot",
  "latest",
  "top_categories",
  "dashboard_analytics",
  "total"
]);

export function createStartupTiming({
  now = () => performance.now(),
  slowThresholdMs = 1_000,
  logger = console
} = {}) {
  const startedAt = now();
  const durations = new Map();
  let finished = false;

  function add(name, milliseconds) {
    assertPhase(name);
    const duration = Number(milliseconds);
    if (!Number.isFinite(duration) || duration < 0) return;
    durations.set(name, (durations.get(name) ?? 0) + duration);
  }

  async function measure(name, operation) {
    assertPhase(name);
    const phaseStartedAt = now();
    try {
      return await operation();
    } finally {
      add(name, now() - phaseStartedAt);
    }
  }

  function finish({ route = "/api/dashboard", status = 200 } = {}) {
    if (finished) return snapshot();
    finished = true;
    add("total", now() - startedAt);
    const timings = snapshot();
    if (timings.total >= slowThresholdMs) {
      logger.warn("[startup] slow request", { route, status, timings });
    }
    return timings;
  }

  function snapshot() {
    return Object.fromEntries([...durations].map(([name, duration]) => [name, round(duration)]));
  }

  function serverTiming() {
    return Object.entries(snapshot())
      .map(([name, duration]) => `${name};dur=${duration}`)
      .join(", ");
  }

  return { add, measure, finish, snapshot, serverTiming };
}

function assertPhase(name) {
  if (!PHASES.has(name)) throw new Error(`Unknown startup timing phase: ${name}`);
}

function round(value) {
  return Math.round(value * 10) / 10;
}
