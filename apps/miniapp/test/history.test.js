import test from "node:test";
import assert from "node:assert/strict";

import { expenseCountLabel, formatCustomRangeLabel, groupByDay, periodTotal } from "../src/history.js";

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
  assert.equal(formatCustomRangeLabel("2026-06-10", "2026-06-11", "ru"), "10 июня–11 июня");
  assert.equal(formatCustomRangeLabel("2026-06-10", "2026-06-10", "ru"), "10 июня");
});

test("formatCustomRangeLabel returns empty for invalid dates", () => {
  assert.equal(formatCustomRangeLabel("nope", "2026-06-11", "ru"), "");
  assert.equal(formatCustomRangeLabel("", "", "ru"), "");
});
