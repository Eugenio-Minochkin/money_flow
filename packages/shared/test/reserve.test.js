import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateReserveForecast,
  calculateReserveState,
  validateReserveCapacity
} from "../src/reserve.js";

test("keeps the full reserve when regular spending stays within available regular budget", () => {
  assert.deepEqual(calculateReserveState({
    budgetAmount: 60000,
    plannedAmount: 12500,
    reserveAmount: 4000,
    regularSpentAmount: 30000
  }), {
    availableRegular: 43500,
    savedAmount: 4000,
    eatenAmount: 0,
    overBudgetAmount: 0,
    status: "saved"
  });
});

test("reports the partially used reserve", () => {
  assert.deepEqual(calculateReserveState({
    budgetAmount: 60000,
    plannedAmount: 12500,
    reserveAmount: 4000,
    regularSpentAmount: 45000
  }), {
    availableRegular: 43500,
    savedAmount: 2500,
    eatenAmount: 1500,
    overBudgetAmount: 0,
    status: "partially_used"
  });
});

test("distinguishes a used-up reserve from overall regular-budget overrun", () => {
  assert.deepEqual(calculateReserveState({
    budgetAmount: 60000,
    plannedAmount: 12500,
    reserveAmount: 4000,
    regularSpentAmount: 48000
  }), {
    availableRegular: 43500,
    savedAmount: 0,
    eatenAmount: 4000,
    overBudgetAmount: 500,
    status: "used_up_and_over_budget"
  });
});

test("rejects a reserve above free budget", () => {
  assert.deepEqual(validateReserveCapacity({
    budgetAmount: 60000,
    plannedAmount: 12500,
    reserveAmount: 50000
  }), {
    valid: false,
    freeBudget: 47500
  });
});

test("keeps reserve forecast neutral through day four in the period timezone", () => {
  assert.deepEqual(calculateReserveForecast({
    dayOfMonth: 4,
    daysInMonth: 30,
    regularSpentAmount: 12000,
    budgetAmount: 60000,
    plannedAmount: 12500,
    reserveAmount: 4000
  }), {
    status: "early",
    forecastRegularSpentAmount: null,
    savedAmount: null,
    eatenAmount: null,
    overBudgetAmount: null
  });
});

test("forecasts reserve state from regular spending starting on day five", () => {
  const forecast = calculateReserveForecast({
    dayOfMonth: 5,
    daysInMonth: 30,
    regularSpentAmount: 7500,
    budgetAmount: 60000,
    plannedAmount: 12500,
    reserveAmount: 4000
  });

  assert.equal(forecast.forecastRegularSpentAmount, 45000);
  assert.equal(forecast.status, "partially_used");
  assert.equal(forecast.savedAmount, 2500);
  assert.equal(forecast.eatenAmount, 1500);
});
