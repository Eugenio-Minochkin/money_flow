import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCalendarMonth,
  buildHistoryRequestParams,
  canNavigateToMonth,
  createCalendarDraft,
  expenseCountLabel,
  formatCustomRangeLabel,
  groupByDay,
  historyFilterFromLaunchParams,
  periodTotal,
  buildHistoryAnalytics,
  historySummaryKey,
  selectRangeDate,
  shiftCalendarMonth
} from "../src/history.js";

test("history analytics combines categories after the largest five and sorts top expenses", () => {
  const expenses = [
    ["food_cafe", 40, "Coffee"],
    ["transport", 30, "Taxi"],
    ["health", 20, "Doctor"],
    ["home", 10, "Lamp"],
    ["travel", 8, "Train"],
    ["education", 7, "Book"],
    ["gifts_help", 5, "Gift"]
  ].map(([category_slug, amount_base, description], index) => ({ id: index + 1, category_slug, amount_base, description }));

  const analytics = buildHistoryAnalytics(expenses, 5);

  assert.equal(analytics.total, 120);
  assert.equal(analytics.count, 7);
  assert.deepEqual(analytics.categories.map(({ category_slug, amount }) => [category_slug, amount]), [
    ["food_cafe", 40],
    ["transport", 30],
    ["health", 20],
    ["home", 10],
    ["travel", 8],
    ["other", 12]
  ]);
  assert.deepEqual(analytics.topExpenses.map((item) => item.description), ["Coffee", "Taxi", "Doctor"]);
  assert.equal(analytics.categories[0].share, 33.33);
});

test("history analytics returns a stable empty model", () => {
  assert.deepEqual(buildHistoryAnalytics([]), { total: 0, count: 0, categories: [], topExpenses: [] });
});

test("history analytics keeps one Other slice when stored Other and small categories coexist", () => {
  const analytics = buildHistoryAnalytics([
    { category_slug: "food_cafe", amount_base: 50 },
    { category_slug: "transport", amount_base: 30 },
    { category_slug: "other", amount_base: 40 },
    { category_slug: "education", amount_base: 5 }
  ], 2);

  assert.deepEqual(analytics.categories.map(({ category_slug, amount }) => [category_slug, amount]), [
    ["food_cafe", 50],
    ["transport", 30],
    ["other", 45]
  ]);
});

test("history summary uses filtered wording only when a search query is active", () => {
  assert.equal(historySummaryKey(""), null);
  assert.equal(historySummaryKey(" coffee "), "history.total.filtered");
});

test("history launch uses the exact weekly report range as a custom filter", () => {
  assert.deepEqual(historyFilterFromLaunchParams(new URLSearchParams({
    view: "history",
    period: "custom",
    fromDate: "2026-06-15",
    toDate: "2026-06-21"
  })), {
    period: "custom",
    fromDate: "2026-06-15",
    toDate: "2026-06-21",
    monthKey: ""
  });
});

test("history launch keeps the month chip while using the exact monthly report range", () => {
  assert.deepEqual(historyFilterFromLaunchParams(new URLSearchParams({
    view: "history",
    period: "month",
    monthKey: "2026-06",
    fromDate: "2026-06-01",
    toDate: "2026-06-30"
  })), {
    period: "month",
    monthKey: "2026-06",
    fromDate: "2026-06-01",
    toDate: "2026-06-30"
  });
});

test("invalid history launch parameters fall back to the current-month filter", () => {
  assert.deepEqual(historyFilterFromLaunchParams(new URLSearchParams({
    view: "history",
    period: "month",
    monthKey: "2026-06",
    fromDate: "2026-06-01",
    toDate: "2026-07-01"
  })), {
    period: "month",
    monthKey: "",
    fromDate: "",
    toDate: ""
  });
});

test("historical month sends its report dates in the first history request while keeping the month filter", () => {
  assert.equal(buildHistoryRequestParams(100, "", {
    period: "month",
    monthKey: "2026-06",
    fromDate: "2026-06-01",
    toDate: "2026-06-30"
  }).toString(), "telegramUserId=100&search=&fromDate=2026-06-01&toDate=2026-06-30");
});

test("manual month filter has no launch dates and requests the current local month", () => {
  assert.equal(buildHistoryRequestParams(100, "coffee", {
    period: "month",
    monthKey: "",
    fromDate: "",
    toDate: ""
  }).toString(), "telegramUserId=100&search=coffee&period=month");
});

test("groups expenses by local calendar day and sums base amounts", () => {
  const groups = groupByDay([
    { spent_at: "2026-06-02T10:00:00+07:00", amount_base: 70, amount_original: 70 },
    { spent_at: "2026-06-02T12:00:00+07:00", amount_base: 80, amount_original: 80 },
    { spent_at: "2026-06-03T12:00:00+07:00", amount_original: 120 }
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].total, 150);
  assert.equal(groups[0].items.length, 2);
  assert.equal(groups[1].total, 120);
});

test("periodTotal sums amount_base across all expenses", () => {
  assert.equal(periodTotal([
    { amount_base: 100 },
    { amount_base: 250.5 },
    { amount_base: 0 }
  ]), 350.5);
});

test("periodTotal returns 0 for empty list", () => {
  assert.equal(periodTotal([]), 0);
});

test("expenseCountLabel applies Russian plural rules", () => {
  assert.equal(expenseCountLabel(0, "ru"), "Расходов нет");
  assert.equal(expenseCountLabel(1, "ru"), "1 расход");
  assert.equal(expenseCountLabel(2, "ru"), "2 расхода");
  assert.equal(expenseCountLabel(5, "ru"), "5 расходов");
  assert.equal(expenseCountLabel(11, "ru"), "11 расходов");
  assert.equal(expenseCountLabel(21, "ru"), "21 расход");
  assert.equal(expenseCountLabel(22, "ru"), "22 расхода");
  assert.equal(expenseCountLabel(25, "ru"), "25 расходов");
});

test("expenseCountLabel uses English singular and plural", () => {
  assert.equal(expenseCountLabel(0, "en"), "No expenses");
  assert.equal(expenseCountLabel(1, "en"), "1 expense");
  assert.equal(expenseCountLabel(12, "en"), "12 expenses");
});

test("formatCustomRangeLabel formats a range and single day", () => {
  assert.equal(formatCustomRangeLabel("2026-06-10", "2026-06-11", "ru"), "10 июня — 11 июня");
  assert.equal(formatCustomRangeLabel("2026-06-10", "2026-06-10", "ru"), "10 июня");
});

test("formatCustomRangeLabel returns empty for invalid dates", () => {
  assert.equal(formatCustomRangeLabel("nope", "2026-06-11", "ru"), "");
  assert.equal(formatCustomRangeLabel("", "", "ru"), "");
});

test("selectRangeDate selects one day, normalizes the second tap and restarts on the third", () => {
  const first = selectRangeDate({}, "2026-06-10");
  assert.deepEqual(first, {
    startDate: "2026-06-10",
    endDate: "2026-06-10",
    selectionComplete: false
  });

  const second = selectRangeDate(first, "2026-06-08");
  assert.deepEqual(second, {
    startDate: "2026-06-08",
    endDate: "2026-06-10",
    selectionComplete: true
  });

  assert.deepEqual(selectRangeDate(second, "2026-06-15"), {
    startDate: "2026-06-15",
    endDate: "2026-06-15",
    selectionComplete: false
  });
});

test("calendar month is Monday-first and disables future days", () => {
  const cells = buildCalendarMonth("2026-06", "2026-06-18", {
    startDate: "2026-06-10",
    endDate: "2026-06-12"
  });

  assert.equal(cells.length, 30);
  assert.equal(cells[0].date, "2026-06-01");
  assert.equal(cells[0].weekdayIndex, 0);
  assert.equal(cells[9].isStart, true);
  assert.equal(cells[10].isInRange, true);
  assert.equal(cells[11].isEnd, true);
  assert.equal(cells[17].disabled, false);
  assert.equal(cells[18].disabled, true);
});

test("calendar navigation cannot move beyond the current month", () => {
  assert.equal(shiftCalendarMonth("2026-06", -1), "2026-05");
  assert.equal(shiftCalendarMonth("2026-12", 1), "2027-01");
  assert.equal(canNavigateToMonth("2026-06", "2026-06-18"), true);
  assert.equal(canNavigateToMonth("2026-07", "2026-06-18"), false);
});

test("calendar draft preserves an applied custom range and its visible month", () => {
  assert.deepEqual(createCalendarDraft({
    period: "custom",
    fromDate: "2026-05-10",
    toDate: "2026-05-12"
  }, "2026-06-18"), {
    startDate: "2026-05-10",
    endDate: "2026-05-12",
    selectionComplete: true,
    visibleMonth: "2026-05"
  });
});

test("calendar draft starts empty in the current month for a quick period", () => {
  assert.deepEqual(createCalendarDraft({
    period: "month",
    fromDate: "",
    toDate: ""
  }, "2026-06-18"), {
    startDate: "",
    endDate: "",
    selectionComplete: false,
    visibleMonth: "2026-06"
  });
});
