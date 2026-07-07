import test from "node:test";
import assert from "node:assert/strict";

import { createReportScheduler } from "../src/reportScheduler.js";

test("scheduler tick delegates to report service", async () => {
  const calls = [];
  const scheduler = createReportScheduler({
    enabled: true,
    reportService: {
      async runDueReports(input) {
        calls.push(input);
        return { checked: 1, sent: 1 };
      }
    }
  });

  const result = await scheduler.tick(new Date("2026-07-01T02:30:00Z"));

  assert.deepEqual(result, { checked: 1, sent: 1 });
  assert.equal(calls[0].now.toISOString(), "2026-07-01T02:30:00.000Z");
});

test("scheduler start uses initial delay and interval once", () => {
  const calls = [];
  const timerApi = {
    setTimeout(fn, ms) {
      calls.push(["timeout", ms, typeof fn]);
      return 1;
    },
    setInterval(fn, ms) {
      calls.push(["interval", ms, typeof fn]);
      return 2;
    },
    clearTimeout() {},
    clearInterval() {}
  };
  const scheduler = createReportScheduler({
    enabled: true,
    intervalMs: 60_000,
    timerApi,
    reportService: { async runDueReports() {} }
  });

  scheduler.start();
  scheduler.start();

  assert.deepEqual(calls, [
    ["timeout", 10_000, "function"],
    ["interval", 60_000, "function"]
  ]);
});

test("disabled scheduler tick is skipped", async () => {
  const scheduler = createReportScheduler({
    enabled: false,
    reportService: {
      async runDueReports() {
        throw new Error("should not run");
      }
    }
  });

  assert.deepEqual(await scheduler.tick(), { skipped: true, reason: "disabled" });
});

test("scheduler failures notify admins and keep the existing skipped result", async () => {
  const alerts = [];
  const scheduler = createReportScheduler({
    enabled: true,
    logger: { error() {} },
    adminAlertService: {
      async notifyAdminError(error, context) {
        alerts.push({ error, context });
      }
    },
    reportService: {
      async runDueReports() {
        throw new Error("report delivery failed");
      }
    }
  });

  const result = await scheduler.tick(new Date("2026-07-07T14:30:00Z"));

  assert.deepEqual(result, { skipped: true, reason: "error" });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].error.message, "report delivery failed");
  assert.deepEqual(alerts[0].context, {
    source: "scheduler",
    jobName: "report-scheduler",
    operation: "run_due_reports"
  });
});
