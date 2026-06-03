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
      spent_at: "2026-06-02T09:30:00+07:00",
      needs_review: true
    }
  ]);

  assert.match(text, /coffee/);
  assert.match(text, /02 июн|Jun 02/);
  assert.match(text, /70 THB/);
  assert.match(text, /<b>/);
});

test("formats saved summary with budget context", () => {
  const text = formatSavedSummary(75, {
    ...snapshot(),
    recoveryAdvice: {
      active: true,
      state: "warn",
      requiredPerDay: 675,
      forecastOverBudget: 18000
    }
  });
  const normalized = normalizeSpaces(text);

  assert.match(text, /75 THB/);
  assert.match(normalized, /75 \/ 1 475 THB/);
  assert.match(normalized, /735 \/ 9 800 THB/);
  assert.match(normalized, /735 \/ 42/);
  assert.match(text, /1,75%/);
  assert.match(text, /Можно в день до конца месяца/);
  assert.match(text, /896,38 THB/);
  assert.match(text, /Можно еще сегодня/);
  assert.match(text, /Вернуться в бюджет/);
  assert.match(text, /675 THB/);
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

test("formats saved summary in English when requested", () => {
  const text = formatSavedSummary(75, snapshot(), { language: "en" });

  assert.match(text, /Saved expense/);
  assert.match(text, /Today/);
  assert.match(text, /Month/);
  assert.doesNotMatch(text, /Записал/);
});

function snapshot() {
  return {
    today: 75,
    dayPlanLimit: 1475,
    week: 735,
    weekPlanLimit: 9800,
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
