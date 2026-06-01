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
    month: 28500,
    monthlyBudget: 45000,
    remaining: 16500,
    daysLeftInMonth: 24,
    safeToSpendPerDay: 687.5,
    status: "above_plan"
  });
});
