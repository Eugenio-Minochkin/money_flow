const DEFAULT_INITIAL_DELAY_MS = 10_000;
const DEFAULT_INTERVAL_MS = 60 * 60_000;

export function createReportScheduler(options = {}) {
  const timerApi = options.timerApi ?? globalThis;
  const logger = options.logger ?? console;
  const adminAlertService = options.adminAlertService ?? null;
  const enabled = options.enabled !== false;
  const intervalMs = Math.max(Number(options.intervalMs ?? DEFAULT_INTERVAL_MS), 60_000);
  let timeoutId = null;
  let intervalId = null;
  let running = false;

  async function tick(now = new Date()) {
    if (!enabled) return { skipped: true, reason: "disabled" };
    if (running) return { skipped: true, reason: "running" };
    running = true;
    try {
      return await options.reportService.runDueReports({ now });
    } catch (error) {
      logger.error?.("[reports] scheduler failed", error);
      try {
        await adminAlertService?.notifyAdminError?.(error, {
          source: "scheduler",
          jobName: "report-scheduler",
          operation: "run_due_reports"
        });
      } catch {
        // Reporting scheduler failures must stay contained even if alerting fails.
      }
      return { skipped: true, reason: "error" };
    } finally {
      running = false;
    }
  }

  function runScheduledTick() {
    void tick(new Date());
  }

  return {
    tick,
    start() {
      if (!enabled || timeoutId !== null || intervalId !== null) return;
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
