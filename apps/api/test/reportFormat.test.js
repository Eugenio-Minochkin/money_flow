import test from "node:test";
import assert from "node:assert/strict";

import { formatMonthlyReport, formatWeeklyReport } from "../src/reportFormat.js";

test("formats RU weekly report with planned, large, topup and no outside-budget block", () => {
  const text = formatWeeklyReport(reportFixture(), { language: "ru" });

  assert.match(text, /📊 Итоги недели/);
  assert.match(text, /15–21 июня/);
  assert.match(text, /Потрачено: <b>1 700 THB<\/b>/);
  assert.match(text, /Плановые оплаты — <b>500 THB<\/b>/);
  assert.match(text, /Остальные расходы — <b>1 200 THB<\/b>/);
  assert.match(text, /Заметные разовые траты внутри суммы/);
  assert.match(text, /Всего заметными: <b>900 THB<\/b>/);
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
  assert.match(text, /Spent: <b>1,700 THB<\/b>/);
  assert.doesNotMatch(text, /Notable one-off expenses inside the total/);
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

  assert.match(text, /Spent: <b>100\.00 USD<\/b>/);
  assert.match(text, /Planned payments .* <b>33\.34 USD<\/b>/);
  assert.match(text, /Other expenses .* <b>66\.66 USD<\/b>/);
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

  assert.match(text, /Spent: <b>1,700 THB<\/b>/);
  assert.match(text, /Planned payments .* <b>500 THB<\/b>/);
  assert.match(text, /Other expenses .* <b>1,200 THB<\/b>/);
  assert.match(text, /≈ 52\.15 USD/);
  assert.doesNotMatch(text, /Planned payments .* USD/);
  assert.doesNotMatch(text, /Other expenses .* USD/);
});

test("formats primary THB partition from report display so visible values add up", () => {
  const text = formatMonthlyReport({
    ...reportFixture({ reportType: "monthly" }),
    currency: "THB",
    metrics: {
      ...reportFixture().metrics,
      totalSpent: 49765,
      plannedPaidTotal: 22118,
      regularTotal: 27646,
      reportDisplay: {
        currency: "THB",
        totalSpent: 49765,
        plannedPaidTotal: 22118,
        regularTotal: 27647
      },
      display: {
        currency: "USD",
        totalSpent: 1520.33,
        plannedPaidTotal: 676.09,
        regularTotal: 844.24
      }
    },
    largeExpenses: [],
    budgetTopups: [],
    plannedPayments: []
  }, { language: "en" });

  assert.match(text, /Spent: <b>49,765 THB<\/b>/);
  assert.match(text, /Planned payments .* <b>22,118 THB<\/b>/);
  assert.match(text, /Other expenses .* <b>27,647 THB<\/b>/);
  assert.doesNotMatch(text, /Other expenses .*27,646 THB/);
  assert.doesNotMatch(text, /Planned payments .* USD/);
  assert.doesNotMatch(text, /Other expenses .* USD/);
});

test("does not render secondary equivalent when display currency equals report currency", () => {
  const text = formatWeeklyReport({
    ...reportFixture(),
    currency: "THB",
    metrics: {
      ...reportFixture().metrics,
      display: {
        currency: "THB",
        totalSpent: 1700,
        plannedPaidTotal: 500,
        regularTotal: 1200
      }
    }
  }, { language: "en" });

  assert.match(text, /Spent: <b>1,700 THB<\/b>/);
  assert.doesNotMatch(text, /≈/);
});

test("formats RU monthly report with unpaid planned due date", () => {
  const text = formatMonthlyReport(reportFixture({ reportType: "monthly" }), { language: "ru" });

  assert.match(text, /🧾 Июнь закрыт/);
  assert.match(text, /Бюджет месяца/);
  assert.match(text, /Стартовый бюджет — 10 000 THB/);
  assert.match(text, /Пополнения — \+1 000 THB/);
  assert.match(text, /Итоговый бюджет — <b>11 000 THB<\/b>/);
  assert.match(text, /Не отмечено: 700 THB/);
  assert.match(text, /internet — 700 THB, не отмечено, 25 июня/);
});

test("formats EN monthly report", () => {
  const text = formatMonthlyReport(reportFixture({ reportType: "monthly" }), { language: "en" });

  assert.match(text, /🧾 June is closed/);
  assert.match(text, /Monthly budget/);
  assert.match(text, /Starting budget — 10,000 THB/);
  assert.match(text, /Top-ups — \+1,000 THB/);
  assert.match(text, /Final budget — <b>11,000 THB<\/b>/);
  assert.match(text, /internet — 700 THB, not marked, June 25/);
});

test("formats monthly budget and remaining equivalents as secondary display lines", () => {
  const text = formatMonthlyReport({
    ...reportFixture({ reportType: "monthly" }),
    currency: "THB",
    metrics: {
      ...reportFixture().metrics,
      totalSpent: 48000,
      plannedPaidTotal: 14500,
      regularTotal: 33500,
      display: {
        currency: "USD",
        totalSpent: 1310,
        plannedPaidTotal: 395,
        regularTotal: 915
      }
    },
    budget: {
      baseBudget: 45000,
      topupsTotal: 5000,
      amount: 50000,
      remaining: 2000,
      display: {
        currency: "USD",
        amount: 1365,
        remaining: 55
      }
    }
  }, { language: "en" });

  assert.match(text, /Spent: <b>48,000 THB<\/b>\n≈ 1,310\.00 USD/);
  assert.match(text, /Final budget — <b>50,000 THB<\/b>\n≈ 1,365\.00 USD/);
  assert.match(text, /Remaining: <b>2,000 THB<\/b>\n≈ 55\.00 USD/);
  assert.match(text, /Planned payments .* <b>14,500 THB<\/b>/);
  assert.match(text, /Other expenses .* <b>33,500 THB<\/b>/);
  assert.doesNotMatch(text, /Planned payments .* USD/);
  assert.doesNotMatch(text, /Other expenses .* USD/);
});

test("formats monthly pace with everyday spending primary and total average secondary", () => {
  const text = formatMonthlyReport({
    ...reportFixture({ reportType: "monthly" }),
    metrics: {
      ...reportFixture().metrics,
      plannedPaidTotal: 22118,
      averagePerDay: 1658.83,
      regularAveragePerDay: 921.57
    },
    largeExpenses: [],
    budgetTopups: [],
    plannedPayments: []
  }, { language: "en" });

  assert.match(text, /Monthly pace:\nEveryday spending: <b>922 THB\/day<\/b>\nIncluding planned payments: 1,659 THB\/day/);
});

test("formats monthly pace with one average line when no planned payments were paid", () => {
  const text = formatMonthlyReport({
    ...reportFixture({ reportType: "monthly" }),
    metrics: {
      ...reportFixture().metrics,
      plannedPaidTotal: 0,
      averagePerDay: 922,
      regularAveragePerDay: 922
    },
    largeExpenses: [],
    budgetTopups: [],
    plannedPayments: []
  }, { language: "en" });

  assert.match(text, /Monthly pace:\nAverage: <b>922 THB\/day<\/b>/);
  assert.doesNotMatch(text, /Including planned payments/);
});

test("formats weekly average with everyday spending primary and total average secondary", () => {
  const text = formatWeeklyReport({
    ...reportFixture(),
    metrics: {
      ...reportFixture().metrics,
      plannedPaidTotal: 500,
      averagePerDay: 242.86,
      regularAveragePerDay: 171.43
    },
    largeExpenses: [],
    budgetTopups: [],
    plannedPayments: []
  }, { language: "en" });

  assert.match(text, /Everyday spending: <b>171 THB\/day<\/b>\nIncluding planned payments: 243 THB\/day/);
});

test("formats overspent equivalent as a secondary display line", () => {
  const text = formatMonthlyReport({
    ...reportFixture({ reportType: "monthly" }),
    currency: "THB",
    budget: {
      ...reportFixture().budget,
      remaining: -3000,
      display: {
        currency: "USD",
        remaining: -82
      }
    }
  }, { language: "en" });

  assert.match(text, /Overspent: <b>3,000 THB<\/b>\n≈ 82\.00 USD/);
});

test("escapes user-provided report names while keeping Telegram HTML tags valid", () => {
  const text = formatMonthlyReport({
    ...reportFixture({ reportType: "monthly" }),
    plannedPayments: [
      { name: "Rent & <Home>", amount: 500, paid: true }
    ],
    largeExpenses: [
      { date: "2026-06-17", name: "Phone & <case>", amount: 3000 }
    ],
    topCategories: [
      { name: "Food & <Cafe>", amount: 1000 }
    ],
    budgetTopups: []
  }, { language: "en" });

  assert.match(text, /Rent &amp; &lt;Home&gt;/);
  assert.match(text, /Phone &amp; &lt;case&gt;/);
  assert.match(text, /Food &amp; &lt;Cafe&gt;/);
  assert.doesNotMatch(text, /Rent & <Home>/);
  assert.doesNotMatch(text, /Phone & <case>/);
  assert.match(text, /Spent: <b>1,700 THB<\/b>/);
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
