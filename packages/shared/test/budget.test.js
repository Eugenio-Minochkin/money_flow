import test from "node:test";
import assert from "node:assert/strict";

import { calculateBudgetSnapshot } from "../src/budget.js";

test("calculates month remaining and safe-to-spend", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 820,
    monthTotal: 28500,
    monthlyBudget: 45000,
    now: new Date("2026-06-07T10:00:00+07:00")
  });

  assert.deepEqual(snapshot, {
    today: 820,
    week: 0,
    month: 28500,
    monthlyBudget: 45000,
    remaining: 16500,
    plannedRemaining: 0,
    freeRemaining: 16500,
    budgetProgressPercent: 63.33,
    daysInMonth: 30,
    elapsedDaysInMonth: 7,
    daysLeftInMonth: 24,
    dailyPlanLimit: 1500,
    forecastMonthTotal: 122142.86,
    planDeviation: 18000,
    safeToSpendPerDay: 687.5,
    display: {
      currency: "USD",
      today: 0,
      week: 0,
      month: 0,
      plannedRemaining: 0,
      freeRemaining: 0,
      dailyPlanLimit: 0,
      forecastMonthTotal: 0,
      planDeviation: 0,
      safeToSpendPerDay: 0
    },
    status: "above_plan"
  });
});

test("calculates monthly budget progress percent", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 75,
    monthTotal: 735,
    monthlyBudget: 45000,
    now: new Date("2026-06-02T10:00:00+07:00")
  });

  assert.equal(snapshot.budgetProgressPercent, 1.63);
});

test("calculates display currency safe-to-spend", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 360,
    todayDisplayTotal: 10,
    weekTotal: 720,
    weekDisplayTotal: 20,
    monthTotal: 3600,
    monthDisplayTotal: 100,
    monthlyBudget: 45000,
    plannedRemainingTotal: 3600,
    plannedRemainingDisplayTotal: 100,
    displayCurrency: "USD",
    now: new Date("2026-06-07T10:00:00+07:00")
  });

  assert.equal(snapshot.display.month, 100);
  assert.equal(snapshot.display.plannedRemaining, 100);
  assert.equal(snapshot.display.safeToSpendPerDay, 43.75);
  assert.equal(snapshot.display.dailyPlanLimit, 41.67);
  assert.equal(snapshot.display.forecastMonthTotal, 428.57);
  assert.equal(snapshot.display.planDeviation, -191.67);
});

test("subtracts planned expenses from free-to-spend", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 820,
    weekTotal: 4300,
    monthTotal: 10000,
    monthlyBudget: 45000,
    plannedRemainingTotal: 23700,
    now: new Date("2026-06-07T10:00:00+07:00")
  });

  assert.equal(snapshot.week, 4300);
  assert.equal(snapshot.plannedRemaining, 23700);
  assert.equal(snapshot.freeRemaining, 11300);
  assert.equal(snapshot.safeToSpendPerDay, 470.83);
});
