import test from "node:test";
import assert from "node:assert/strict";

import { formatDraft, formatSavedSummary, formatTotals, formatWeeklyReport } from "../src/telegramFormat.js";

test("formats a draft with total and review warning", () => {
  const text = formatDraft([
    {
      amount: 70,
      currency: "THB",
      description: "coffee",
      category_slug: "food_cafe",
      needs_review: true
    }
  ]);

  assert.match(text, /coffee/);
  assert.match(text, /70 THB/);
  assert.match(text, /<b>/);
});

test("formats saved summary with budget context", () => {
  const text = formatSavedSummary(75, snapshot());

  assert.match(text, /75 THB/);
  assert.match(text, /735 \/ 42/);
  assert.match(text, /1,75%/);
  assert.match(text, /896,38 THB/);
});

test("formats command totals for month and budget", () => {
  assert.match(formatTotals("/month", snapshot()), /735 \/ 42/);
  assert.match(normalizeSpaces(formatTotals("/budget", snapshot())), /15 269,99 THB/);
});

test("formats weekly report with top categories", () => {
  const text = formatWeeklyReport({
    snapshot: snapshot(),
    topCategories: [{ category_slug: "food_cafe", total: 735 }]
  });

  assert.match(text, /735 THB/);
  assert.match(normalizeSpaces(text), /42 000 THB/);
});

function snapshot() {
  return {
    today: 75,
    week: 735,
    month: 735,
    monthlyBudget: 42000,
    plannedRemaining: 15269.99,
    freeRemaining: 25995.01,
    budgetProgressPercent: 1.75,
    forecastMonthTotal: 11025,
    planDeviation: -2065,
    safeToSpendPerDay: 896.38,
    status: "below_plan"
  };
}

function normalizeSpaces(value) {
  return value.replaceAll("\u00a0", " ");
}
