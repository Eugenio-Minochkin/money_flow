import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCalendarMonth,
  canNavigateToMonth,
  createCalendarDraft,
  expenseCountLabel,
  formatCustomRangeLabel,
  groupByDay,
  periodTotal,
  selectRangeDate,
  shiftCalendarMonth
} from "../src/history.js";

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
