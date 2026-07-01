import test from "node:test";
import assert from "node:assert/strict";

import { buildReportMetrics, createReportService, roundPartitionForDisplay } from "../src/reportService.js";

test("report metrics include large one-off in total but exclude it from daily projection base", () => {
  const metrics = buildReportMetrics({
    currency: "THB",
    expenses: [
      expense({ id: 1, amount: 300, impact: "regular" }),
      expense({ id: 2, amount: 500, impact: "planned" }),
      expense({ id: 3, amount: 900, impact: "large_oneoff" })
    ],
    paidPlannedPayments: [
      { expense_id: 2, amount_base: 500, planned_amount_base: 700 }
    ]
  });

  assert.equal(metrics.totalSpent, 1700);
  assert.equal(metrics.plannedPaidTotal, 500);
  assert.equal(metrics.regularTotal, 1200);
  assert.equal(metrics.largeTotal, 900);
  assert.equal(metrics.dailyProjectionBase, 300);
  assert.equal(metrics.outOfBudgetTotal, 0);
  assert.equal(metrics.showOutsideBudget, false);
});

test("paid planned total uses actual linked expense amount instead of template amount", () => {
  const metrics = buildReportMetrics({
    currency: "THB",
    expenses: [
      expense({ id: 10, amount: 450, impact: "planned" })
    ],
    paidPlannedPayments: [
      { expense_id: 10, amount_base: 450, planned_amount_base: 1000 }
    ]
  });

  assert.equal(metrics.totalSpent, 450);
  assert.equal(metrics.plannedPaidTotal, 450);
  assert.equal(metrics.regularTotal, 0);
});

test("large planned payment is not double-counted as regular or large", () => {
  const metrics = buildReportMetrics({
    currency: "THB",
    expenses: [
      expense({ id: 1, amount: 200, impact: "regular" }),
      expense({ id: 2, amount: 5000, impact: "planned" })
    ],
    paidPlannedPayments: [
      { expense_id: 2, amount_base: 5000, planned_amount_base: 5000 }
    ],
    largeThreshold: 1000
  });

  assert.equal(metrics.totalSpent, 5200);
  assert.equal(metrics.plannedPaidTotal, 5000);
  assert.equal(metrics.regularTotal, 200);
  assert.equal(metrics.largeTotal, 0);
  assert.equal(metrics.dailyProjectionBase, 200);
});

test("visual partition sums to displayed total after rounding", () => {
  const partition = roundPartitionForDisplay({
    total: 100,
    planned: 33.335,
    currency: "USD"
  });

  assert.equal(partition.total, 100);
  assert.equal(partition.plannedPaidTotal, 33.34);
  assert.equal(partition.regularTotal, 66.66);
  assert.equal(partition.plannedPaidTotal + partition.regularTotal, partition.total);
});

test("report metrics display partition derives regular display from rounded total minus rounded planned", () => {
  const metrics = buildReportMetrics({
    currency: "THB",
    displayCurrency: "USD",
    expenses: [
      expense({ id: 1, amount: 66.665, impact: "regular", displayAmount: 66.665 }),
      expense({ id: 2, amount: 33.335, impact: "planned", displayAmount: 33.335 })
    ],
    paidPlannedPayments: [
      { expense_id: 2, amount_base: 33.335, display: { amount: 33.335 } }
    ]
  });

  assert.equal(metrics.display.totalSpent, 100);
  assert.equal(metrics.display.plannedPaidTotal, 33.34);
  assert.equal(metrics.display.regularTotal, 66.66);
  assert.equal(metrics.display.plannedPaidTotal + metrics.display.regularTotal, metrics.display.totalSpent);
});

test("report metrics include primary report display partition with rounded regular remainder", () => {
  const metrics = buildReportMetrics({
    currency: "THB",
    expenses: [
      expense({ id: 1, amount: 27646, impact: "regular" }),
      expense({ id: 2, amount: 22118, impact: "planned" }),
      expense({ id: 3, amount: 1, impact: "regular" })
    ],
    paidPlannedPayments: [
      { expense_id: 2, amount_base: 22118 }
    ]
  });

  assert.equal(metrics.reportDisplay.totalSpent, 49765);
  assert.equal(metrics.reportDisplay.plannedPaidTotal, 22118);
  assert.equal(metrics.reportDisplay.regularTotal, 27647);
  assert.equal(metrics.reportDisplay.plannedPaidTotal + metrics.reportDisplay.regularTotal, metrics.reportDisplay.totalSpent);
});

test("report metrics expose regular average per day separately from total average", () => {
  const metrics = buildReportMetrics({
    currency: "THB",
    expenses: [
      expense({ id: 1, amount: 27647, impact: "regular" }),
      expense({ id: 2, amount: 22118, impact: "planned" })
    ],
    paidPlannedPayments: [
      { expense_id: 2, amount_base: 22118 }
    ],
    periodDays: 30
  });

  assert.equal(metrics.averagePerDay, 1658.83);
  assert.equal(metrics.regularAveragePerDay, 921.57);
});

test("budget top-ups are capacity and do not count as spending", () => {
  const metrics = buildReportMetrics({
    currency: "THB",
    expenses: [expense({ id: 1, amount: 300, impact: "regular" })],
    paidPlannedPayments: [],
    budgetTopups: [{ amount_base: 1000 }]
  });

  assert.equal(metrics.totalSpent, 300);
  assert.equal(metrics.budgetTopupsTotal, 1000);
  assert.equal(metrics.regularTotal, 300);
});

test("runDueReports sends monthly before weekly when both are due", async () => {
  const sent = [];
  const repo = reportRepo();
  const service = createReportService({
    repository: repo,
    miniAppUrl: "http://localhost:3000",
    now: () => new Date("2024-07-01T02:30:00Z"),
    sendMessage: async (message) => {
      sent.push(message);
      return { message_id: sent.length };
    }
  });

  const summary = await service.runDueReports();

  assert.equal(summary.sent, 2);
  assert.deepEqual(sent.map((message) => message.reportType), ["monthly", "weekly"]);
  assert.deepEqual(repo.events.filter((event) => event.name.endsWith("_report_sent")).map((event) => event.name), [
    "monthly_report_sent",
    "weekly_report_sent"
  ]);
});

test("runDueReports dry-run does not create deliveries or send Telegram messages", async () => {
  const sent = [];
  const repo = reportRepo();
  const service = createReportService({
    repository: repo,
    miniAppUrl: "http://localhost:3000",
    now: () => new Date("2026-07-01T02:30:00Z"),
    sendMessage: async (message) => sent.push(message)
  });

  const summary = await service.runDueReports({ dryRun: true });

  assert.equal(summary.willSend, 1);
  assert.equal(summary.sent, 0);
  assert.equal(sent.length, 0);
  assert.equal(repo.created.length, 0);
});

test("runDueReports skips duplicate sent deliveries", async () => {
  const repo = reportRepo({
    existingDelivery: { status: "sent" },
    now: new Date("2026-07-06T02:30:00Z")
  });
  const service = createReportService({
    repository: repo,
    miniAppUrl: "http://localhost:3000",
    now: () => new Date("2026-07-06T02:30:00Z"),
    sendMessage: async () => {
      throw new Error("should not send");
    }
  });

  const summary = await service.runDueReports();

  assert.equal(summary.skipped, 1);
  assert.equal(summary.sent, 0);
});

test("delivery race skips when claimReportDelivery loses the row", async () => {
  const sent = [];
  const repo = reportRepo({
    now: new Date("2026-07-06T02:30:00Z"),
    claimDeliveryResult: null
  });
  const service = createReportService({
    repository: repo,
    miniAppUrl: "http://localhost:3000",
    now: () => new Date("2026-07-06T02:30:00Z"),
    sendMessage: async (message) => {
      sent.push(message);
      return { message_id: 1 };
    }
  });

  const summary = await service.runDueReports();

  assert.equal(summary.skipped, 1);
  assert.equal(summary.sent, 0);
  assert.equal(sent.length, 0);
  assert.equal(repo.claimed.length, 1);
});

test("failed delivery is claimed back to pending and retried", async () => {
  const sent = [];
  const repo = reportRepo({
    now: new Date("2026-07-06T02:30:00Z"),
    existingDelivery: { status: "failed" },
    claimDeliveryResult: { id: 9, status: "pending" }
  });
  const service = createReportService({
    repository: repo,
    miniAppUrl: "http://localhost:3000",
    now: () => new Date("2026-07-06T02:30:00Z"),
    sendMessage: async (message) => {
      sent.push(message);
      return { message_id: 77 };
    }
  });

  const summary = await service.runDueReports();

  assert.equal(summary.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(repo.claimed[0].force, false);
  assert.equal(repo.sent[0].telegramMessageId, 77);
});

test("force delivery claims an existing sent row before sending", async () => {
  const sent = [];
  const repo = reportRepo({
    existingDelivery: { status: "sent" },
    claimDeliveryResult: { id: 10, status: "pending" }
  });
  const service = createReportService({
    repository: repo,
    miniAppUrl: "http://localhost:3000",
    now: () => new Date("2026-07-06T02:30:00Z"),
    sendMessage: async (message) => {
      sent.push(message);
      return { message_id: 78 };
    }
  });

  const outcome = await service.sendReportForUser(repo.candidate, "weekly", {
    periodKey: "2026-W27",
    periodStartUtc: new Date("2026-06-29T00:00:00Z"),
    periodEndUtc: new Date("2026-07-06T00:00:00Z"),
    timezoneUsed: "UTC",
    localStartDate: "2026-06-29",
    localEndDate: "2026-07-05"
  }, { force: true, current: new Date("2026-07-06T02:30:00Z") });

  assert.equal(outcome, "sent");
  assert.equal(sent.length, 1);
  assert.equal(repo.claimed[0].force, true);
});

test("blocked Telegram errors mark delivery failed and user bot blocked", async () => {
  const repo = reportRepo({ now: new Date("2026-07-06T02:30:00Z") });
  const service = createReportService({
    repository: repo,
    miniAppUrl: "http://localhost:3000",
    now: () => new Date("2026-07-06T02:30:00Z"),
    sendMessage: async () => {
      const error = new Error("Forbidden: bot was blocked by the user");
      error.status = 403;
      throw error;
    }
  });

  const summary = await service.runDueReports();

  assert.equal(summary.failed, 1);
  assert.deepEqual(repo.blockedUsers, [1]);
  assert.equal(repo.failed[0].errorCode, "403");
  assert.equal(repo.failed[0].reportType, "weekly");
});

test("monthly backfill skips no-activity reports and records skipped delivery", async () => {
  const repo = reportRepo({
    reportData: {
      metrics: {
        totalSpent: 0,
        averagePerDay: 0,
        plannedPaidTotal: 0,
        regularTotal: 0,
        largeTotal: 0,
        budgetTopupsTotal: 0,
        outOfBudgetTotal: 0,
        showOutsideBudget: false
      },
      plannedPayments: [],
      largeExpenses: [],
      budgetTopups: [],
      topCategories: []
    }
  });
  const service = createReportService({
    repository: repo,
    miniAppUrl: "http://localhost:3000",
    now: () => new Date("2026-07-01T02:30:00Z"),
    sendMessage: async () => {
      throw new Error("should not send");
    }
  });

  const summary = await service.backfillMonthlyReport("2026-06", { dryRun: false });

  assert.equal(summary.skipped, 1);
  assert.equal(summary.sent, 0);
  assert.equal(repo.created.length, 1);
  assert.equal(repo.created[0].status, "skipped");
  assert.equal(repo.created[0].skipReason, "no_activity");
  assert.equal(repo.skipped.length, 0);
});

test("monthly backfill dry-run reports no-activity skip without delivery side effects", async () => {
  const repo = reportRepo({
    reportData: {
      metrics: {
        totalSpent: 0,
        averagePerDay: 0,
        plannedPaidTotal: 0,
        regularTotal: 0,
        largeTotal: 0,
        budgetTopupsTotal: 0,
        outOfBudgetTotal: 0,
        showOutsideBudget: false
      },
      plannedPayments: [],
      largeExpenses: [],
      budgetTopups: [],
      topCategories: []
    }
  });
  const service = createReportService({
    repository: repo,
    miniAppUrl: "http://localhost:3000",
    now: () => new Date("2026-07-01T02:30:00Z")
  });

  const summary = await service.backfillMonthlyReport("2026-06");

  assert.equal(summary.skipped, 1);
  assert.equal(summary.willSend, 0);
  assert.equal(repo.created.length, 0);
  assert.equal(repo.skipped.length, 0);
});

test("monthly backfill rejects current and future periods", async () => {
  const service = createReportService({
    repository: reportRepo(),
    miniAppUrl: "http://localhost:3000",
    now: () => new Date("2026-07-01T02:30:00Z")
  });

  await assert.rejects(
    () => service.backfillMonthlyReport("2026-07"),
    /closed month/
  );
  await assert.rejects(
    () => service.backfillMonthlyReport("2026-08"),
    /closed month/
  );
});

function expense({ id, amount, impact, displayAmount = amount }) {
  return {
    id,
    amount_base: amount,
    display: { amount: displayAmount },
    budget_impact: impact,
    description: `expense ${id}`,
    category_slug: "other",
    spent_at: "2026-06-15T12:00:00Z"
  };
}

function reportRepo(options = {}) {
  const now = options.now ?? new Date("2024-07-01T02:30:00Z");
  const candidate = {
    id: 1,
    telegram_user_id: 100,
    timezone: "Asia/Bangkok",
    interface_language: "en"
  };
  return {
    candidate,
    created: [],
    claimed: [],
    sent: [],
    failed: [],
    skipped: [],
    blockedUsers: [],
    events: [],
    async listReportCandidates() {
      return [candidate];
    },
    async getReportDelivery() {
      return options.existingDelivery ?? null;
    },
    async createReportDelivery(input) {
      this.created.push(input);
      if ("createDeliveryResult" in options) return options.createDeliveryResult;
      return { id: this.created.length, ...input };
    },
    async claimReportDelivery(input) {
      this.claimed.push(input);
      if ("claimDeliveryResult" in options) return options.claimDeliveryResult;
      return { id: this.claimed.length, status: "pending", ...input };
    },
    async markReportDeliverySent(input) {
      this.sent.push(input);
      return input;
    },
    async markReportDeliveryFailed(input) {
      this.failed.push(input);
      return input;
    },
    async markReportDeliverySkipped(input) {
      this.skipped.push(input);
      return input;
    },
    async markUserBotBlocked(userId) {
      this.blockedUsers.push(userId);
    },
    async recordAppEvent(userId, name, metadata) {
      this.events.push({ userId, name, metadata });
    },
    async buildReportDataForDelivery(_user, reportType, period) {
      const override = options.reportData ?? {};
      return {
        reportType,
        currency: "THB",
        period,
        metrics: override.metrics ?? {
          totalSpent: 100,
          averagePerDay: 10,
          plannedPaidTotal: 0,
          regularTotal: 100,
          largeTotal: 0,
          budgetTopupsTotal: 0,
          outOfBudgetTotal: 0,
          showOutsideBudget: false
        },
        budget: { amount: 1000, baseBudget: 1000, topupsTotal: 0, remaining: 900 },
        plannedPayments: override.plannedPayments ?? [],
        largeExpenses: override.largeExpenses ?? [],
        budgetTopups: override.budgetTopups ?? [],
        topCategories: override.topCategories ?? [{ name: "Food", amount: 100 }],
        insight: reportType,
        generatedAt: now
      };
    }
  };
}
