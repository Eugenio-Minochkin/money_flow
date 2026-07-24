import test from "node:test";
import assert from "node:assert/strict";

import { formatMonthlyReport, formatWeeklyReport } from "../src/reportFormat.js";

test("formats RU weekly report with localized categories, comparison and takeaway", () => {
  const text = formatWeeklyReport(weeklyFixture({ language: "ru" }), { language: "ru" });

  assert.match(text, /📊 Итоги недели/);
  assert.match(text, /13–19 июля/);
  assert.match(text, /Потрачено: <b>8 713 THB<\/b>/);
  assert.match(text, /≈ 260,01 USD/);
  assert.match(text, /📈 На 18% больше, чем неделей ранее/);
  assert.match(text, /В среднем — 1 245 THB\/день/);
  assert.match(text, /🏷️ Главные категории/);
  assert.match(text, /1. Подарки \/ помощь — 2 839 THB · 33%/);
  assert.match(text, /Две главные категории составили <b>63% всех расходов недели<\/b>\./);
  assert.match(text, /🧾 Самые большие расходы/);
  assert.match(text, /1. Аренда квартиры — 15 000 THB/);
  assert.match(text, /🔄 Что изменилось/);
  assert.match(text, /• На Подарки \/ помощь потрачено на 1 200 THB больше/);
  assert.doesNotMatch(text, /Общие расходы выросли/);
  assert.doesNotMatch(text, /Внутри этой суммы/);
  assert.doesNotMatch(text, /Заметные разовые траты/);
  assert.doesNotMatch(text, /Пополнения бюджета/);
});

test("formats EN weekly report and hides empty optional blocks", () => {
  const text = formatWeeklyReport(weeklyFixture({
    language: "en",
    takeaway: null,
    needsAttention: null,
    changes: [],
    largestExpenses: []
  }), { language: "en" });

  assert.match(text, /📊 Weekly summary/);
  assert.match(text, /July 13–19/);
  assert.match(text, /Spent: <b>8,713 THB<\/b>/);
  assert.match(text, /📈 18% more than the previous week/);
  assert.match(text, /Daily average — 1,245 THB\/day/);
  assert.match(text, /🏷️ Top categories/);
  assert.match(text, /The top two categories accounted for <b>63% of all spending this week<\/b>\./);
  assert.doesNotMatch(text, /🧾 Largest expenses/);
  assert.doesNotMatch(text, /This week's takeaway/);
  assert.doesNotMatch(text, /Needs attention/);
  assert.doesNotMatch(text, /\n\n\n/);
});

test("weekly report never leaks internal category keys in RU or EN", () => {
  const ru = formatWeeklyReport(weeklyFixture({ language: "ru" }), { language: "ru" });
  const en = formatWeeklyReport(weeklyFixture({ language: "en" }), { language: "en" });
  for (const text of [ru, en]) {
    assert.doesNotMatch(text, /gifts_help|food_cafe|category_slug|_[a-z]/);
  }
});

test("weekly report shows at most three categories and five largest expenses", () => {
  const text = formatWeeklyReport(weeklyFixture({
    language: "en",
    topCategories: [
      { name: "A", amount: 4000, percent: 45 },
      { name: "B", amount: 3000, percent: 34 },
      { name: "C", amount: 1000, percent: 11 },
      { name: "D", amount: 500, percent: 6 }
    ],
    largestExpenses: [
      { name: "e1", amount: 5000 },
      { name: "e2", amount: 4000 },
      { name: "e3", amount: 3000 },
      { name: "e4", amount: 2000 },
      { name: "e5", amount: 1000 },
      { name: "e6", amount: 500 }
    ]
  }), { language: "en" });

  const categoryMatches = text.match(/^\d+\. .+ — .+ · \d+%$/gm) ?? [];
  assert.equal(categoryMatches.length, 3);
  assert.doesNotMatch(text, /e6/);
  assert.match(text, /1\. e1 — 5,000 THB/);
  assert.match(text, /5\. e5 — 1,000 THB/);
});

test("weekly report omits the largest-expenses block cleanly when there are none", () => {
  const text = formatWeeklyReport(weeklyFixture({ language: "en", largestExpenses: [] }), { language: "en" });
  assert.doesNotMatch(text, /Largest expenses/);
  assert.doesNotMatch(text, /\n\n\n/);
});

test("first week hides comparison, what-changed and takeaway, shows closing line", () => {
  const text = formatWeeklyReport(weeklyFixture({
    language: "ru",
    firstWeek: true,
    comparison: { available: false },
    changes: [],
    takeaway: null
  }), { language: "ru" });

  assert.doesNotMatch(text, /больше, чем неделей/);
  assert.doesNotMatch(text, /Что изменилось/);
  assert.doesNotMatch(text, /Главное за неделю/);
  assert.match(text, /Первая неделя учёта завершена/);
});

test("comparable week shows the comparison and what-changed blocks", () => {
  const text = formatWeeklyReport(weeklyFixture({ language: "en" }), { language: "en" });
  assert.match(text, /18% more than the previous week/);
  assert.match(text, /🔄 What changed/);
  assert.match(text, /• Spending on Gifts &amp; Help increased by 1,200 THB/);
  assert.doesNotMatch(text, /Total spending increased by/);
});

test("needs-attention block renders unpaid payments and excludes them from the spent total", () => {
  const report = weeklyFixture({
    language: "ru",
    metrics: { ...weeklyFixture().metrics, totalSpent: 7713, averagePerDay: 1102, display: { currency: "USD", totalSpent: 230 } },
    needsAttention: {
      total: 1000,
      count: 1,
      moreCount: 0,
      shown: [{ name: "English", amount: 1000, dueDate: "2026-07-15", overdue: false }]
    }
  });
  const text = formatWeeklyReport(report, { language: "ru" });

  assert.match(text, /Потрачено: <b>7 713 THB<\/b>/);
  assert.match(text, /⚠️ Требует внимания/);
  assert.match(text, /English — 1 000 THB/);
  assert.match(text, /Оплата за 15 июля не отмечена и не входит в расходы недели\./);
});

test("overdue unpaid payment uses the stronger wording", () => {
  const report = weeklyFixture({
    language: "en",
    needsAttention: {
      total: 1000,
      count: 1,
      moreCount: 0,
      shown: [{ name: "English", amount: 1000, dueDate: "2026-07-08", overdue: true }]
    }
  });
  const text = formatWeeklyReport(report, { language: "en" });
  assert.match(text, /The payment due on July 8 is still not marked as paid\./);
  assert.doesNotMatch(text, /not included in this week's spending/);
});

test("needs-attention collapses extra payments into a summary line", () => {
  const report = weeklyFixture({
    language: "ru",
    needsAttention: {
      total: 3000,
      count: 5,
      moreCount: 2,
      shown: [
        { name: "English", amount: 1000, dueDate: "2026-07-15", overdue: true },
        { name: "Gym", amount: 500, dueDate: "2026-07-16", overdue: false },
        { name: "Internet", amount: 700, dueDate: "2026-07-17", overdue: false }
      ]
    }
  });
  const text = formatWeeklyReport(report, { language: "ru" });
  assert.match(text, /Не отмечено: 3 000 THB/);
  assert.match(text, /И ещё 2 оплаты/);
});

test("needs-attention more-payments line pluralizes correctly in RU and EN", () => {
  const ruOne = formatWeeklyReport(weeklyFixture({
    language: "ru",
    needsAttention: { total: 1000, count: 4, moreCount: 1, shown: [{ name: "A", amount: 1000, dueDate: "2026-07-15", overdue: false }] }
  }), { language: "ru" });
  assert.match(ruOne, /И ещё 1 оплата/);

  const ruFive = formatWeeklyReport(weeklyFixture({
    language: "ru",
    needsAttention: { total: 5000, count: 8, moreCount: 5, shown: [{ name: "A", amount: 1000, dueDate: "2026-07-15", overdue: false }] }
  }), { language: "ru" });
  assert.match(ruFive, /И ещё 5 оплат/);

  const enTwo = formatWeeklyReport(weeklyFixture({
    language: "en",
    needsAttention: { total: 2000, count: 5, moreCount: 2, shown: [{ name: "A", amount: 1000, dueDate: "2026-07-15", overdue: false }] }
  }), { language: "en" });
  assert.match(enTwo, /And 2 more payments/);

  const enOne = formatWeeklyReport(weeklyFixture({
    language: "en",
    needsAttention: { total: 1000, count: 4, moreCount: 1, shown: [{ name: "A", amount: 1000, dueDate: "2026-07-15", overdue: false }] }
  }), { language: "en" });
  assert.match(enOne, /And 1 more payment/);
});

test("what-changed block renders provided category changes and hides when there are none", () => {
  const withChanges = formatWeeklyReport(weeklyFixture({
    language: "en",
    changes: [{ slug: "food_cafe", name: "Food & Cafés", direction: "down", delta: -900, percentDelta: 25, currentTotal: 2700, priorTotal: 3600, isNew: false }]
  }), { language: "en" });
  assert.match(withChanges, /• Spending on Food &amp; Cafés decreased by 25%/);

  const withoutChanges = formatWeeklyReport(weeklyFixture({ language: "en", changes: [] }), { language: "en" });
  assert.doesNotMatch(withoutChanges, /What changed/);
});

test("weekly report formats numbers and dates correctly per language", () => {
  const ru = formatWeeklyReport(weeklyFixture({ language: "ru" }), { language: "ru" });
  const en = formatWeeklyReport(weeklyFixture({ language: "en" }), { language: "en" });
  assert.match(ru, /8 713 THB/);
  assert.match(en, /8,713 THB/);
  assert.match(ru, /13–19 июля/);
  assert.match(en, /July 13–19/);
});

test("weekly report formats a cross-month period label correctly", () => {
  const period = { periodKey: "2026-W31", localStartDate: "2026-07-29", localEndDate: "2026-08-04" };
  const ru = formatWeeklyReport(weeklyFixture({ language: "ru", period }), { language: "ru" });
  const en = formatWeeklyReport(weeklyFixture({ language: "en", period }), { language: "en" });
  assert.match(ru, /29 июля — 4 августа/);
  assert.match(en, /July 29–August 4/);
});

test("weekly report shows budget top-up and outside-budget lines when present and hides them when absent", () => {
  const metrics = { ...weeklyFixture().metrics, budgetTopupsTotal: 5000, outOfBudgetTotal: 1200, showOutsideBudget: true };

  const ru = formatWeeklyReport(weeklyFixture({ language: "ru", metrics }), { language: "ru" });
  assert.match(ru, /➕ Бюджет пополнен на 5 000 THB/);
  assert.match(ru, /🚧 Вне бюджета: 1 200 THB/);

  const en = formatWeeklyReport(weeklyFixture({ language: "en", metrics }), { language: "en" });
  assert.match(en, /➕ Budget increased by 5,000 THB/);
  assert.match(en, /🚧 Outside budget: 1,200 THB/);

  const hidden = formatWeeklyReport(weeklyFixture({ language: "ru" }), { language: "ru" });
  assert.doesNotMatch(hidden, /Бюджет пополнен/);
  assert.doesNotMatch(hidden, /Вне бюджета/);
});

// --- Monthly report (unchanged structure, localized category names via DTO) ---

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

test("formats monthly partition from display metrics when provided", () => {
  const text = formatMonthlyReport({
    ...reportFixture({ reportType: "monthly" }),
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
  const text = formatMonthlyReport({
    ...reportFixture({ reportType: "monthly" }),
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
    ...weeklyFixture(),
    currency: "THB",
    metrics: {
      ...weeklyFixture().metrics,
      display: { currency: "THB", totalSpent: 8713 }
    }
  }, { language: "en" });

  assert.match(text, /Spent: <b>8,713 THB<\/b>/);
  assert.doesNotMatch(text, /≈/);
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

function weeklyFixture(overrides = {}) {
  const language = overrides.language ?? "ru";
  const giftsName = language === "en" ? "Gifts & Help" : "Подарки / помощь";
  const foodName = language === "en" ? "Food & Cafés" : "Еда и кафе";
  const homeName = language === "en" ? "Home" : "Дом";
  return {
    reportType: "weekly",
    currency: "THB",
    period: {
      periodKey: "2026-W29",
      localStartDate: "2026-07-13",
      localEndDate: "2026-07-19"
    },
    metrics: {
      totalSpent: 8713,
      averagePerDay: 1245,
      display: { currency: "USD", totalSpent: 260.01 }
    },
    topCategories: [
      { name: giftsName, amount: 2839, percent: 33 },
      { name: foodName, amount: 2611, percent: 30 },
      { name: homeName, amount: 1492, percent: 17 }
    ],
    topTwoCategoryShare: 63,
    comparison: { available: true, direction: "up", percentDelta: 18, currentTotal: 8713, priorTotal: 7384, delta: 1329 },
    changes: [
      { slug: "gifts_help", name: giftsName, direction: "up", delta: 1200, percentDelta: 73, currentTotal: 2839, priorTotal: 1639, isNew: false }
    ],
    largestExpenses: [
      { name: language === "en" ? "Apartment rent" : "Аренда квартиры", amount: 15000 },
      { name: language === "en" ? "Therapist" : "Психолог", amount: 2500 },
      { name: language === "en" ? "Tickets" : "Билеты", amount: 2100 }
    ],
    needsAttention: overrides.needsAttention ?? null,
    takeaway: overrides.takeaway === undefined
      ? (language === "en"
        ? "Spending rose mainly because of rent."
        : "Расходы выросли главным образом из-за аренды.")
      : overrides.takeaway,
    firstWeek: overrides.firstWeek === undefined ? false : overrides.firstWeek,
    ...stripFixtureOnly(overrides)
  };
}

function stripFixtureOnly(overrides) {
  const { language, takeaway, needsAttention, firstWeek, ...rest } = overrides;
  return rest;
}

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
