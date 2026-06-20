const DEFAULT_INITIAL_DELAY_MS = 10_000;
const DEFAULT_CHECK_INTERVAL_MINUTES = 15;

export function releaseDigestLocalParts(now, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour)
  };
}

export function createReleaseDigestScheduler(options) {
  const timerApi = options.timerApi ?? globalThis;
  const repository = options.repo ?? options.repository;
  const onError = options.onError ?? (() => {});
  let running = false;
  let timeoutId = null;
  let intervalId = null;

  async function tick(now = new Date()) {
    if (!options.enabled) {
      return { skipped: true, reason: "disabled" };
    }

    const local = releaseDigestLocalParts(now, options.timezone);
    if (local.hour !== options.sendHour) {
      return { skipped: true, reason: "outside_send_hour" };
    }
    if (running) {
      return { skipped: true, reason: "running" };
    }

    running = true;
    try {
      const existingRun = await repository.getReleaseDigestRunForLocalDate(
        local.date,
        options.timezone
      );
      if (existingRun) {
        return { skipped: true, reason: "existing_run" };
      }

      return await options.releaseNotesService.sendReleaseDigestSinceLastRun(now, {
        trigger: "auto",
        timezone: options.timezone,
        localDate: local.date
      });
    } finally {
      running = false;
    }
  }

  async function runScheduledTick(now) {
    const tickNow = now instanceof Date ? now : new Date();
    try {
      return await tick(tickNow);
    } catch (error) {
      try {
        await onError(error);
      } catch {
        // Scheduled callbacks must never leak a rejected promise to the process.
      }
      return undefined;
    }
  }

  return {
    tick,
    start() {
      if (!options.enabled || timeoutId !== null || intervalId !== null) return;

      const intervalMs =
        (options.checkIntervalMinutes ?? DEFAULT_CHECK_INTERVAL_MINUTES) * 60_000;
      timeoutId = timerApi.setTimeout(runScheduledTick, DEFAULT_INITIAL_DELAY_MS);
      intervalId = timerApi.setInterval(runScheduledTick, intervalMs);
    },
    stop() {
      if (timeoutId !== null) {
        timerApi.clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (intervalId !== null) {
        timerApi.clearInterval(intervalId);
        intervalId = null;
      }
    }
  };
}
