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

test("formats draft dates in Bangkok timezone", () => {
  const text = formatDraft([{
    amount: 40000,
    currency: "IDR",
    description: "Shopee",
    category_slug: "other",
    spent_at: "2026-05-31T17:00:00.000Z",
    needs_review: false
  }], { language: "ru" });

  assert.match(text, /01 июн|01 Ð¸ÑŽÐ½/);
  assert.doesNotMatch(text, /31 мая|31 Ð¼Ð°Ñ/);
});


test("formats draft budget impact markers for planned and large expenses", () => {
  const text = formatDraft([
    {
      amount: 70,
      currency: "THB",
      description: "coffee",
      category_slug: "food_cafe",
      spent_at: "2026-06-02T09:30:00+07:00",
      budget_impact: "regular"
    },
    {
      amount: 1000,
      currency: "THB",
      description: "rent",
      category_slug: "home",
      spent_at: "2026-06-02T09:30:00+07:00",
      budget_impact: "planned"
    },
    {
      amount: 5000,
      currency: "THB",
      description: "phone",
      category_slug: "other",
      spent_at: "2026-06-02T09:30:00+07:00",
      budget_impact: "large_oneoff"
    }
  ], { language: "ru" });

  assert.match(text, /🧾 Плановая/);
  assert.match(text, /📦 Крупная/);
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
  assert.match(text, /Обычные/);
  assert.match(normalized, /75 THB \/ 1 475 THB/);
  assert.match(normalized, /735 THB \/ 42 000 THB/);
  assert.match(text, /1,75%/);
  assert.match(text, /Плановые сегодня/);
  assert.match(text, /Крупные сегодня/);
  assert.match(text, /Всего за день/);
  assert.match(text, /Вернуться в бюджет/);
  assert.match(text, /675 THB/);
});

test("formats saved summary with planned and large daily aggregates", () => {
  const text = formatSavedSummary(80, {
    ...snapshot(),
    today: 802,
    dayPlanLimit: 615,
    plannedToday: 1000,
    largeToday: 2000
  });
  const normalized = normalizeSpaces(text);

  assert.match(normalized, /Обычные: <b>802 THB \/ 615 THB<\/b>/);
  assert.match(normalized, /Перерасход: <b>187 THB<\/b>/);
  assert.match(normalized, /Плановые сегодня: <b>1 000 THB<\/b>/);
  assert.match(normalized, /Крупные сегодня: <b>2 000 THB<\/b>/);
  assert.match(normalized, /Всего за день: <b>3 802 THB<\/b>/);
});

test("formats command totals for month and budget", () => {
  assert.match(normalizeSpaces(formatTotals("/month", snapshot())), /735 THB \/ 42 000 THB/);
  assert.match(normalizeSpaces(formatTotals("/budget", snapshot())), /15 270 THB/);
});

test("formats money decimals by currency in Telegram UI", () => {
  assert.match(normalizeSpaces(formatDraft([{ amount: 8720.81, currency: "THB", description: "food", category_slug: "other" }])), /8 721 THB/);
  assert.match(normalizeSpaces(formatDraft([{ amount: 266.58, currency: "USD", description: "food", category_slug: "other" }], { language: "en" })), /266\.58 USD/);
  assert.match(normalizeSpaces(formatDraft([{ amount: 45.2, currency: "EUR", description: "food", category_slug: "other" }], { language: "en" })), /45\.20 EUR/);
  assert.match(normalizeSpaces(formatDraft([{ amount: 120.5, currency: "GEL", description: "food", category_slug: "other" }], { language: "en" })), /120\.50 GEL/);
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

  assert.match(text, /Saved/);
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
