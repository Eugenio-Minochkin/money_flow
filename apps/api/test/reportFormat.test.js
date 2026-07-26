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
  assert.match(text, /• Подарки \/ помощь — на 1 200 THB больше/);
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

// --- Monthly report (new bilingual structure) ---

test("formats a full RU monthly report with the new structure", () => {
  const text = formatMonthlyReport(monthlyFixture({ language: "ru" }), { language: "ru" });

  assert.match(text, /🧾 Итоги июня/);
  assert.match(text, /💸 Потрачено: <b>49 765 THB<\/b>/);
  assert.match(text, /≈ 1 520,33 USD/);
  assert.match(text, /📈 На 12% больше, чем в мае/);
  assert.match(text, /В среднем — 1 659 THB\/день/);
  assert.match(text, /🎯 Бюджет месяца/);
  assert.match(text, /⚠️ Бюджет почти использован/);
  assert.match(text, /Использовано 98% из <b>51 000 THB<\/b>/);
  assert.match(text, /Осталось: <b>1 235 THB<\/b>/);
  assert.match(text, /🧩 Структура расходов/);
  assert.match(text, /Плановые оплаты — <b>22 118 THB<\/b> · 44%/);
  assert.match(text, /Остальные расходы — <b>27 647 THB<\/b> · 56%/);
  assert.match(text, /Без плановых оплат — в среднем 922 THB\/день\./);
  assert.match(text, /🏷️ Главные категории/);
  assert.match(text, /1\. Дом — 14 920 THB · 30%/);
  assert.match(text, /Две главные категории составили 56% всех расходов месяца\./);
  assert.match(text, /🧾 Самые большие расходы/);
  assert.match(text, /1\. Оплата квартиры — 13 000 THB/);
  assert.match(text, /🔄 Что изменилось/);
  assert.match(text, /• Дом — на 3 200 THB больше/);
  assert.match(text, /📅 Плановые оплаты/);
  assert.match(text, /✅ Отмечено 11 из 12/);
  assert.match(text, /В расходы месяца включено 22 118 THB/);
  assert.match(text, /⚠️ ChatGPT — 713 THB/);
  assert.match(text, /Оплата за 28 июня всё ещё не отмечена и не входит в расходы месяца\./);
  assert.match(text, /💡 Главное за месяц/);
  assert.doesNotMatch(text, /закрыт|Месяц закрыт/);
  assert.doesNotMatch(text, /\n\n\n/);
});

test("formats a full EN monthly report with the new structure", () => {
  const text = formatMonthlyReport(monthlyFixture({ language: "en" }), { language: "en" });

  assert.match(text, /🧾 June summary/);
  assert.match(text, /💸 Spent: <b>49,765 THB<\/b>/);
  assert.match(text, /≈ 1,520\.33 USD/);
  assert.match(text, /📈 12% more than in May/);
  assert.match(text, /Daily average — 1,659 THB\/day/);
  assert.match(text, /🎯 Monthly budget/);
  assert.match(text, /⚠️ Budget almost fully used/);
  assert.match(text, /Used 98% of <b>51,000 THB<\/b>/);
  assert.match(text, /Remaining: <b>1,235 THB<\/b>/);
  assert.match(text, /🧩 Spending breakdown/);
  assert.match(text, /Planned payments — <b>22,118 THB<\/b> · 44%/);
  assert.match(text, /Other expenses — <b>27,647 THB<\/b> · 56%/);
  assert.match(text, /Excluding planned payments, the daily average was 922 THB\./);
  assert.match(text, /🏷️ Top categories/);
  assert.match(text, /1\. Home — 14,920 THB · 30%/);
  assert.match(text, /The top two categories accounted for 56% of all spending this month\./);
  assert.match(text, /🧾 Largest expenses/);
  assert.match(text, /1\. Apartment rent — 13,000 THB/);
  assert.match(text, /🔄 What changed/);
  assert.match(text, /• Home — 3,200 THB more/);
  assert.match(text, /📅 Planned payments/);
  assert.match(text, /✅ 11 of 12 marked as paid/);
  assert.match(text, /22,118 THB included in this month's spending/);
  assert.match(text, /⚠️ ChatGPT — 713 THB/);
  assert.match(text, /The payment due on June 28 is still not marked as paid and is not included in this month's spending\./);
  assert.match(text, /💡 This month's takeaway/);
});

test("monthly report never leaks internal category keys in RU or EN", () => {
  const ru = formatMonthlyReport(monthlyFixture({ language: "ru" }), { language: "ru" });
  const en = formatMonthlyReport(monthlyFixture({ language: "en" }), { language: "en" });
  for (const text of [ru, en]) {
    assert.doesNotMatch(text, /gifts_help|food_cafe|category_slug|sport_activities|home\b|_[a-z]/);
  }
});

test("monthly report preserves user-provided operation text without auto-translation", () => {
  const ru = formatMonthlyReport(monthlyFixture({
    language: "en",
    largestExpenses: [{ name: "Ужин", amount: 900 }, { name: "Отель в Чиангдао", amount: 1318 }]
  }), { language: "en" });
  assert.match(ru, /1\. Ужин — 900 THB/);
  assert.match(ru, /2\. Отель в Чиангдао — 1,318 THB/);
});

test("monthly report shows at most five categories and five largest expenses", () => {
  const text = formatMonthlyReport(monthlyFixture({
    language: "en",
    topCategories: [
      { name: "A", amount: 4000, percent: 40 },
      { name: "B", amount: 3000, percent: 30 },
      { name: "C", amount: 1500, percent: 15 },
      { name: "D", amount: 1000, percent: 10 },
      { name: "E", amount: 500, percent: 5 },
      { name: "F", amount: 200, percent: 2 }
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
  assert.equal(categoryMatches.length, 5);
  assert.doesNotMatch(text, /F —/);
  assert.doesNotMatch(text, /e6/);
  assert.match(text, /5\. e5 — 1,000 THB/);
});

test("monthly budget block hides when there is no effective budget", () => {
  const text = formatMonthlyReport(monthlyFixture({
    language: "ru",
    budget: { amount: 0, topupsTotal: 0, remaining: 0, available: false, usedPercent: null, overAmount: 0, display: {} }
  }), { language: "ru" });
  assert.doesNotMatch(text, /Бюджет месяца|Использовано|Осталось/);
});

test("monthly budget block shows the within-budget status below the high-usage band", () => {
  const text = formatMonthlyReport(monthlyFixture({
    language: "en",
    metrics: { ...monthlyMetricsBase(), totalSpent: 30000, averagePerDay: 1000 },
    budget: { amount: 51000, topupsTotal: 0, remaining: 21000, available: true, usedPercent: 59, overAmount: 0, display: { currency: "USD", amount: 1300, remaining: 540 } }
  }), { language: "en" });
  assert.match(text, /✅ Within budget/);
  assert.match(text, /Used 59% of <b>51,000 THB<\/b>/);
  assert.doesNotMatch(text, /almost fully used|exceeded/);
});

test("monthly budget block shows the exceeded status and over amount instead of a negative remaining", () => {
  const text = formatMonthlyReport(monthlyFixture({
    language: "ru",
    metrics: { ...monthlyMetricsBase(), totalSpent: 54200, averagePerDay: 1807 },
    budget: { amount: 51000, topupsTotal: 0, remaining: -3200, available: true, usedPercent: 106, overAmount: 3200, display: { currency: "USD", amount: 1530, remaining: -96, overAmount: 96 } }
  }), { language: "ru" });
  assert.match(text, /Бюджет превышен на <b>3 200 THB<\/b>/);
  assert.match(text, /Использовано 106% запланированной суммы/);
  assert.doesNotMatch(text, /Осталось: -|Осталось: <b>-/);
});

test("monthly budget block shows the including-top-ups line and keeps top-ups out of spending", () => {
  const text = formatMonthlyReport(monthlyFixture({
    language: "ru",
    budget: { baseBudget: 46000, topupsTotal: 5000, amount: 51000, remaining: 1235, available: true, usedPercent: 98, overAmount: 0, display: { currency: "USD", amount: 1530, remaining: 37.9 } }
  }), { language: "ru" });
  assert.match(text, /Включая пополнения бюджета: 5 000 THB/);
  assert.match(text, /Потрачено: <b>49 765 THB<\/b>/);
});

test("monthly breakdown visually adds up: rounded planned + rounded regular = rounded total", () => {
  const text = formatMonthlyReport(monthlyFixture({
    language: "en",
    metrics: {
      ...monthlyMetricsBase(),
      totalSpent: 49765,
      plannedPaidTotal: 22118,
      regularTotal: 27647,
      regularAveragePerDay: 922,
      reportDisplay: { currency: "THB", totalSpent: 49765, plannedPaidTotal: 22118, regularTotal: 27647 }
    }
  }), { language: "en" });
  assert.match(text, /Planned payments — <b>22,118 THB<\/b> · 44%/);
  assert.match(text, /Other expenses — <b>27,647 THB<\/b> · 56%/);
  assert.doesNotMatch(text, /Other expenses — <b>27,646 THB/);
});

test("monthly breakdown hides the meaningless split when no planned payments were paid", () => {
  const text = formatMonthlyReport(monthlyFixture({
    language: "ru",
    metrics: { ...monthlyMetricsBase(), plannedPaidTotal: 0, regularTotal: 49765, regularAveragePerDay: 1659, reportDisplay: { currency: "THB", totalSpent: 49765, plannedPaidTotal: 0, regularTotal: 49765 } },
    plannedPayments: [{ name: "rent", amount: 500, paid: false, dueDate: "2026-06-25" }],
    needsAttention: { total: 500, count: 1, moreCount: 0, shown: [{ name: "rent", amount: 500, dueDate: "2026-06-25", overdue: true }] }
  }), { language: "ru" });
  assert.doesNotMatch(text, /Структура расходов/);
  assert.doesNotMatch(text, /Плановые оплаты — <b>0 THB/);
});

test("monthly report hides comparison, what-changed and takeaway on the first full month", () => {
  const text = formatMonthlyReport(monthlyFixture({
    language: "ru",
    comparison: { available: false },
    changes: [],
    takeaway: null,
    firstMonth: true
  }), { language: "ru" });
  assert.doesNotMatch(text, /больше, чем в мае|Что изменилось|Главное за месяц/);
  assert.match(text, /Первый полный месяц учёта завершён/);
});

test("monthly flat comparison is phrased neutrally without growth or decline wording", () => {
  const text = formatMonthlyReport(monthlyFixture({
    language: "en",
    comparison: { available: true, direction: "flat", percentDelta: 1, priorMonthKey: "2026-05" },
    changes: [],
    takeaway: null
  }), { language: "en" });
  assert.match(text, /📈 Roughly in line with May/);
});

test("monthly unpaid block collapses extra payments and pluralizes in RU", () => {
  const text = formatMonthlyReport(monthlyFixture({
    language: "ru",
    plannedPayments: [
      ...Array.from({ length: 7 }, (_, i) => ({ name: `plan ${i + 1}`, amount: 2010, paid: true })),
      { name: "ChatGPT", amount: 1000, paid: false, dueDate: "2026-06-28" },
      { name: "Gym", amount: 1000, paid: false, dueDate: "2026-06-29" },
      { name: "Internet", amount: 1000, paid: false, dueDate: "2026-06-30" },
      { name: "Spa", amount: 600, paid: false, dueDate: "2026-06-20" },
      { name: "Extra", amount: 400, paid: false, dueDate: "2026-06-18" }
    ],
    needsAttention: {
      total: 3000,
      count: 5,
      moreCount: 2,
      shown: [
        { name: "ChatGPT", amount: 1000, dueDate: "2026-06-28", overdue: true },
        { name: "Gym", amount: 1000, dueDate: "2026-06-29", overdue: true },
        { name: "Internet", amount: 1000, dueDate: "2026-06-30", overdue: true }
      ]
    }
  }), { language: "ru" });
  assert.match(text, /✅ Отмечено 7 из 12/);
  assert.match(text, /Не отмечено: 3 000 THB/);
  assert.match(text, /И ещё 2 оплаты/);
});

test("monthly takeaway is hidden when there is no defensible fact", () => {
  const text = formatMonthlyReport(monthlyFixture({
    language: "ru",
    comparison: { available: true, direction: "flat", percentDelta: 1, priorMonthKey: "2026-05" },
    changes: [],
    takeaway: null,
    budget: { amount: 51000, topupsTotal: 0, remaining: 30000, available: true, usedPercent: 41, overAmount: 0, display: { currency: "USD", amount: 1530, remaining: 900 } },
    topTwoCategoryShare: 35,
    metrics: { ...monthlyMetricsBase(), totalSpent: 21000 }
  }), { language: "ru" });
  assert.doesNotMatch(text, /Главное за месяц/);
});

test("monthly report escapes user-provided names while keeping Telegram HTML valid", () => {
  const text = formatMonthlyReport(monthlyFixture({
    language: "en",
    largestExpenses: [{ name: "Phone & <case>", amount: 3000 }],
    topCategories: [{ name: "Food & <Cafe>", amount: 1000, percent: 40 }],
    plannedPayments: [{ name: "Rent & <Home>", amount: 500, paid: false, dueDate: "2026-06-25" }],
    needsAttention: { total: 500, count: 1, moreCount: 0, shown: [{ name: "Rent & <Home>", amount: 500, dueDate: "2026-06-25", overdue: true }] }
  }), { language: "en" });
  assert.match(text, /Phone &amp; &lt;case&gt;/);
  assert.match(text, /Food &amp; &lt;Cafe&gt;/);
  assert.match(text, /Rent &amp; &lt;Home&gt;/);
});

test("monthly report uses a localized category name when an operation has no description", () => {
  const text = formatMonthlyReport(monthlyFixture({
    language: "en",
    largestExpenses: [{ name: "Health", amount: 4920 }]
  }), { language: "en" });
  assert.match(text, /1\. Health — 4,920 THB/);
});

test("monthly report titles use the correct localized month name", () => {
  const may = formatMonthlyReport(monthlyFixture({ language: "ru", period: { periodKey: "2026-05" } }), { language: "ru" });
  const enMarch = formatMonthlyReport(monthlyFixture({ language: "en", period: { periodKey: "2026-03" } }), { language: "en" });
  assert.match(may, /🧾 Итоги мая/);
  assert.match(enMarch, /🧾 March summary/);
});

function monthlyMetricsBase() {
  return {
    currency: "THB",
    totalSpent: 49765,
    plannedPaidTotal: 22118,
    regularTotal: 27647,
    averagePerDay: 1659,
    regularAveragePerDay: 922,
    reportDisplay: { currency: "THB", totalSpent: 49765, plannedPaidTotal: 22118, regularTotal: 27647 },
    display: { currency: "USD", totalSpent: 1520.33, plannedPaidTotal: 676.09, regularTotal: 844.24 }
  };
}

function monthlyFixture(overrides = {}) {
  const language = overrides.language ?? "ru";
  const homeName = language === "en" ? "Home" : "Дом";
  const foodName = language === "en" ? "Food & Cafés" : "Еда и кафе";
  const healthName = language === "en" ? "Health" : "Здоровье";
  const eduName = language === "en" ? "Education" : "Образование";
  const groceriesName = language === "en" ? "Groceries" : "Продукты";
  const rentName = language === "en" ? "Apartment rent" : "Оплата квартиры";
  return {
    reportType: "monthly",
    currency: overrides.currency ?? "THB",
    period: overrides.period ?? { periodKey: "2026-06", localStartDate: "2026-06-01", localEndDate: "2026-06-30" },
    metrics: overrides.metrics ?? monthlyMetricsBase(),
    budget: overrides.budget ?? {
      baseBudget: 51000,
      topupsTotal: 0,
      amount: 51000,
      remaining: 1235,
      available: true,
      usedPercent: 98,
      overAmount: 0,
      display: { currency: "USD", amount: 1529.85, remaining: 37.9 }
    },
    topCategories: overrides.topCategories ?? [
      { name: homeName, amount: 14920, percent: 30 },
      { name: foodName, amount: 12980, percent: 26 },
      { name: healthName, amount: 4920, percent: 10 },
      { name: eduName, amount: 4000, percent: 8 },
      { name: groceriesName, amount: 2866, percent: 6 }
    ],
    topTwoCategoryShare: overrides.topTwoCategoryShare ?? 56,
    comparison: overrides.comparison ?? { available: true, direction: "up", percentDelta: 12, priorMonthKey: "2026-05" },
    changes: overrides.changes ?? [
      { slug: "home", name: homeName, direction: "up", delta: 3200, percentDelta: 27, currentTotal: 14920, priorTotal: 11720, isNew: false },
      { slug: "food_cafe", name: foodName, direction: "up", delta: 1600, percentDelta: 14, currentTotal: 12980, priorTotal: 11380, isNew: false },
      { slug: "health", name: healthName, direction: "down", delta: -1400, percentDelta: -22, currentTotal: 4920, priorTotal: 6320, isNew: false }
    ],
    largestExpenses: overrides.largestExpenses ?? [
      { name: rentName, amount: 13000 },
      { name: language === "en" ? "Therapist" : "Психолог", amount: 2233 },
      { name: language === "en" ? "Therapist" : "Психолог", amount: 2223 },
      { name: language === "en" ? "Hotel in Chiang Dao" : "Отель в Чиангдао", amount: 1318 },
      { name: "English", amount: 1000 }
    ],
    plannedPayments: overrides.plannedPayments ?? [
      ...Array.from({ length: 11 }, () => ({ name: "paid", amount: 2010, paid: true })),
      { name: "ChatGPT", amount: 713, paid: false, dueDate: "2026-06-28" }
    ],
    needsAttention: overrides.needsAttention ?? {
      total: 713,
      count: 1,
      moreCount: 0,
      shown: [{ name: "ChatGPT", amount: 713, dueDate: "2026-06-28", overdue: true }]
    },
    takeaway: overrides.takeaway === undefined
      ? (language === "en"
        ? "You stayed within budget but used 98% of the available amount. The top two categories accounted for 56% of this month's spending."
        : "Вы уложились в бюджет, но использовали 98% доступной суммы. Две главные категории составили 56% расходов месяца.")
      : overrides.takeaway,
    firstMonth: overrides.firstMonth === undefined ? false : overrides.firstMonth
  };
}

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
