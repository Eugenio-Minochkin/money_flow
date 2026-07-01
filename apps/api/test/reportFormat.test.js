import test from "node:test";
import assert from "node:assert/strict";

import { formatMonthlyReport, formatWeeklyReport } from "../src/reportFormat.js";

test("formats RU weekly report with planned, large, topup and no outside-budget block", () => {
  const text = formatWeeklyReport(reportFixture(), { language: "ru" });

  assert.match(text, /📊 Итоги недели/);
  assert.match(text, /15–21 июня/);
  assert.match(text, /Потрачено: 1 700 THB/);
  assert.match(text, /Плановые оплаты — 500 THB/);
  assert.match(text, /Остальные расходы — 1 200 THB/);
  assert.match(text, /Крупные траты внутри суммы/);
  assert.match(text, /Всего крупными: 900 THB/);
  assert.match(text, /Пополнения бюджета на этой неделе/);
  assert.doesNotMatch(text, /Вне бюджета/);
});

test("formats EN weekly report and hides empty optional blocks", () => {
  const text = formatWeeklyReport({
    ...reportFixture(),
    metrics: { ...reportFixture().metrics, largeTotal: 0, budgetTopupsTotal: 0, outOfBudgetTotal: 0, showOutsideBudget: false },
    largeExpenses: [],
    budgetTopups: [],
    plannedPayments: []
  }, { language: "en" });

  assert.match(text, /📊 Weekly summary/);
  assert.match(text, /June 15–21/);
  assert.match(text, /Spent: 1,700 THB/);
  assert.doesNotMatch(text, /Large expenses inside the total/);
  assert.doesNotMatch(text, /Budget top-ups this week/);
  assert.doesNotMatch(text, /Planned payments \(/);
  assert.doesNotMatch(text, /\n\n\n/);
});

test("formats inside partition from display metrics when provided", () => {
  const text = formatWeeklyReport({
    ...reportFixture(),
    currency: "USD",
    metrics: {
      ...reportFixture().metrics,
      totalSpent: 100,
      plannedPaidTotal: 33.335,
      regularTotal: 66.665,
      display: {
        currency: "USD",
        totalSpent: 100,
        plannedPaidTotal: 33.34,
        regularTotal: 66.66
      }
    },
    largeExpenses: [],
    budgetTopups: [],
    plannedPayments: []
  }, { language: "en" });

  assert.match(text, /Spent: 100\.00 USD/);
  assert.match(text, /Planned payments .* 33\.34 USD/);
  assert.match(text, /Other expenses .* 66\.66 USD/);
  assert.doesNotMatch(text, /66\.67 USD/);
});

test("formats partition in the same currency as the spent total", () => {
  const text = formatWeeklyReport({
    ...reportFixture(),
    currency: "THB",
    metrics: {
      ...reportFixture().metrics,
      totalSpent: 1700,
      plannedPaidTotal: 500,
      regularTotal: 1200,
      display: {
        currency: "USD",
        totalSpent: 52.15,
        plannedPaidTotal: 15.33,
        regularTotal: 36.82
      }
    }
  }, { language: "en" });

  assert.match(text, /Spent: 1,700 THB/);
  assert.match(text, /Planned payments .* 500 THB/);
  assert.match(text, /Other expenses .* 1,200 THB/);
  assert.doesNotMatch(text, /USD/);
});

test("formats RU monthly report with unpaid planned due date", () => {
  const text = formatMonthlyReport(reportFixture({ reportType: "monthly" }), { language: "ru" });

  assert.match(text, /🧾 Июнь закрыт/);
  assert.match(text, /Бюджет месяца/);
  assert.match(text, /Стартовый бюджет — 10 000 THB/);
  assert.match(text, /Пополнения — \+1 000 THB/);
  assert.match(text, /Итоговый бюджет — 11 000 THB/);
  assert.match(text, /Не отмечено: 700 THB/);
  assert.match(text, /internet — 700 THB, не отмечено, 25 июня/);
});

test("formats EN monthly report", () => {
  const text = formatMonthlyReport(reportFixture({ reportType: "monthly" }), { language: "en" });

  assert.match(text, /🧾 June is closed/);
  assert.match(text, /Monthly budget/);
  assert.match(text, /Starting budget — 10,000 THB/);
  assert.match(text, /Top-ups — \+1,000 THB/);
  assert.match(text, /Final budget — 11,000 THB/);
  assert.match(text, /internet — 700 THB, not marked, June 25/);
});

test("formats RU monthly report titles with nominative month names", () => {
  const may = formatMonthlyReport(reportFixture({
    reportType: "monthly",
    periodKey: "2026-05",
    localStartDate: "2026-05-01",
    localEndDate: "2026-05-31"
  }), { language: "ru" });
  const march = formatMonthlyReport(reportFixture({
    reportType: "monthly",
    periodKey: "2026-03",
    localStartDate: "2026-03-01",
    localEndDate: "2026-03-31"
  }), { language: "ru" });
  const august = formatMonthlyReport(reportFixture({
    reportType: "monthly",
    periodKey: "2026-08",
    localStartDate: "2026-08-01",
    localEndDate: "2026-08-31"
  }), { language: "ru" });

  assert.match(may, /Май закрыт/);
  assert.match(march, /Март закрыт/);
  assert.match(august, /Август закрыт/);
  assert.doesNotMatch(may, /Маь/);
  assert.doesNotMatch(march, /Марта закрыт/);
  assert.doesNotMatch(august, /Августа закрыт/);
});

function reportFixture(overrides = {}) {
  return {
    reportType: overrides.reportType ?? "weekly",
    currency: "THB",
    period: {
      periodKey: overrides.periodKey ?? (overrides.reportType === "monthly" ? "2026-06" : "2026-W25"),
      localStartDate: overrides.localStartDate ?? "2026-06-15",
      localEndDate: overrides.localEndDate ?? (overrides.reportType === "monthly" ? "2026-06-30" : "2026-06-21")
    },
    metrics: {
      totalSpent: 1700,
      averagePerDay: 242.86,
      plannedPaidTotal: 500,
      regularTotal: 1200,
      largeTotal: 900,
      budgetTopupsTotal: 1000,
      outOfBudgetTotal: 0,
      showOutsideBudget: false
    },
    budget: {
      baseBudget: 10000,
      topupsTotal: 1000,
      amount: 11000,
      remaining: 9300
    },
    plannedPayments: [
      { name: "rent", amount: 500, paid: true },
      { name: "internet", amount: 700, paid: false, dueDate: "2026-06-25" }
    ],
    largeExpenses: [
      { date: "2026-06-17", name: "phone", amount: 900 }
    ],
    budgetTopups: [
      { date: "2026-06-18", amount: 1000 }
    ],
    topCategories: [
      { name: "Food", amount: 1000 },
      { name: "Home", amount: 700 }
    ],
    insight: "You are close to the plan."
  };
}
