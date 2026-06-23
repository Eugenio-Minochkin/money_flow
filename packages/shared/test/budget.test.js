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
    baseCurrency: "THB",
    monthlyBudget: 45000,
    remaining: 16500,
    plannedRemaining: 0,
    freeRemaining: 16500,
    budgetProgressPercent: 63.33,
    daysInMonth: 30,
    elapsedDaysInMonth: 7,
    daysLeftInMonth: 24,
    daysInWeek: 7,
    elapsedDaysInWeek: 7,
    dailyPlanLimit: 1500,
    dayPlanLimit: 1500,
    dayRemaining: 680,
    dayOverrun: 0,
    dayProgressPercent: 54.67,
    weeklyBudget: 10500,
    weekPlanLimit: 10500,
    plannedThisWeek: 0,
    weekRemaining: 10500,
    weekProgressPercent: 0,
    monthRemaining: 16500,
    forecastMonthTotal: 122142.86,
    averageDailyRegularSpending: 4071.43,
    planDeviation: 18000,
    safeToSpendPerDay: 687.5,
    recoveryAdvice: {
      active: true,
      state: "danger",
      overPercent: 171.43,
      forecastOverBudget: 77142.86,
      requiredPerDay: 687.5,
      todayTarget: 687.5,
      display: {
        currency: "USD",
        forecastOverBudget: 0,
        requiredPerDay: 0,
        todayTarget: 0,
        today: 0,
        dayPlanLimit: 0
      },
      daysLeftInMonth: 24
    },
    progress: {
      day: { percent: 54.67, state: "good" },
      week: { percent: 0, state: "good" },
      month: { percent: 63.33, state: "danger" }
    },
    display: {
      currency: "USD",
      today: 0,
      week: 0,
      month: 0,
      monthlyBudget: 0,
      plannedRemaining: 0,
      freeRemaining: 0,
      dailyPlanLimit: 0,
      dayPlanLimit: 0,
      dayRemaining: 0,
      dayOverrun: 0,
      weeklyBudget: 0,
      weekPlanLimit: 0,
      plannedThisWeek: 0,
      weekRemaining: 0,
      monthRemaining: 0,
      forecastMonthTotal: 0,
      averageDailyRegularSpending: 0,
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

test("returns configured base currency", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 14000,
    monthTotal: 14000,
    monthlyBudget: 5000000,
    baseCurrency: "IDR",
    now: new Date("2026-06-07T10:00:00+07:00")
  });

  assert.equal(snapshot.baseCurrency, "IDR");
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
  assert.equal(snapshot.display.forecastMonthTotal, 528.57);
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

test("forecasts regular spending pace plus remaining planned expenses", () => {
  const beforePayment = calculateBudgetSnapshot({
    todayTotal: 3472.27,
    monthTotal: 3772.27,
    monthlyBudget: 32690,
    plannedRemainingTotal: 1305.19,
    now: new Date("2026-06-03T12:00:00+07:00")
  });
  const afterPayment = calculateBudgetSnapshot({
    todayTotal: 4777.46,
    monthTotal: 5077.46,
    monthlyBudget: 32690,
    plannedRemainingTotal: 0,
    paidPlannedMonthTotal: 1305.19,
    now: new Date("2026-06-03T12:00:00+07:00")
  });

  assert.equal(beforePayment.forecastMonthTotal, 39027.89);
  assert.equal(afterPayment.forecastMonthTotal, 39027.89);
});

test("keeps fixed daily budget and excludes non-daily impacts from pace", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 802,
    monthTotal: 12802,
    monthlyBudget: 42000,
    plannedRemainingTotal: 10000,
    paidPlannedMonthTotal: 1000,
    largeOneOffMonthTotal: 2000,
    dayPlanLimit: 1417.2,
    now: new Date("2026-06-06T20:00:00+07:00")
  });

  assert.equal(snapshot.dayPlanLimit, 1417.2);
  assert.equal(snapshot.dayRemaining, 615.2);
  assert.equal(snapshot.dayOverrun, 0);
  assert.equal(snapshot.forecastMonthTotal, 62010);
});

test("reports daily overrun against fixed daily budget", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 802,
    monthTotal: 12802,
    monthlyBudget: 42000,
    dayPlanLimit: 615,
    now: new Date("2026-06-06T20:00:00+07:00")
  });

  assert.equal(snapshot.dayRemaining, 0);
  assert.equal(snapshot.dayOverrun, 187);
  assert.equal(snapshot.dayProgressPercent, 130.41);
});

test("calculates day week and month progress controls", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 650,
    weekTotal: 3350,
    monthTotal: 18800,
    monthlyBudget: 45000,
    weeklyBudget: 11250,
    plannedThisWeekTotal: 1000,
    now: new Date("2026-06-10T10:00:00+07:00")
  });

  assert.equal(snapshot.dayPlanLimit, 1500);
  assert.equal(snapshot.dayRemaining, 850);
  assert.equal(snapshot.dayProgressPercent, 43.33);
  assert.equal(snapshot.weekPlanLimit, 11250);
  assert.equal(snapshot.plannedThisWeek, 1000);
  assert.equal(snapshot.weekRemaining, 6900);
  assert.equal(snapshot.weekProgressPercent, 29.78);
  assert.equal(snapshot.monthRemaining, 26200);
  assert.deepEqual(snapshot.progress.day, { percent: 43.33, state: "good" });
});

test("derives automatic weekly budget when manual weekly budget is not set", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 0,
    weekTotal: 0,
    monthTotal: 0,
    monthlyBudget: 45000,
    now: new Date("2026-06-10T10:00:00+07:00")
  });

  assert.equal(snapshot.weeklyBudget, 10500);
  assert.equal(snapshot.weekPlanLimit, 10500);
});

test("marks progress states by daily threshold and period pace", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 1700,
    weekTotal: 9200,
    monthTotal: 39000,
    monthlyBudget: 45000,
    weeklyBudget: 11250,
    now: new Date("2026-06-10T10:00:00+07:00")
  });

  assert.equal(snapshot.progress.day.state, "danger");
  assert.equal(snapshot.progress.week.state, "danger");
  assert.equal(snapshot.progress.month.state, "danger");
});

test("builds recovery advice when forecast is over budget", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 1415,
    weekTotal: 4942,
    monthTotal: 12300,
    monthDisplayTotal: 377,
    monthlyBudget: 42000,
    plannedRemainingTotal: 10800,
    plannedRemainingDisplayTotal: 331,
    displayCurrency: "USD",
    now: new Date("2026-06-03T10:00:00+07:00")
  });

  assert.equal(snapshot.recoveryAdvice.active, true);
  assert.equal(snapshot.recoveryAdvice.state, "danger");
  assert.equal(snapshot.recoveryAdvice.forecastOverBudget, 91800);
  assert.equal(snapshot.recoveryAdvice.requiredPerDay, 675);
  assert.equal(snapshot.recoveryAdvice.display.forecastOverBudget, 2813.71);
});

test("does not build recovery advice when disabled", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 1415,
    monthTotal: 12300,
    monthlyBudget: 42000,
    budgetAdviceEnabled: false,
    now: new Date("2026-06-03T10:00:00+07:00")
  });

  assert.equal(snapshot.recoveryAdvice.active, false);
});

test("averageDailyRegularSpending excludes planned and large one-off", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 500,
    monthTotal: 10000,
    monthlyBudget: 45000,
    paidPlannedMonthTotal: 3000,
    largeOneOffMonthTotal: 2000,
    now: new Date("2026-06-10T10:00:00+07:00")
  });

  assert.equal(snapshot.averageDailyRegularSpending, 500);
});

test("averageDailyRegularSpending reflects only regular spending", () => {
  const withPlanned = calculateBudgetSnapshot({
    todayTotal: 500,
    monthTotal: 10000,
    monthlyBudget: 45000,
    paidPlannedMonthTotal: 3000,
    now: new Date("2026-06-10T10:00:00+07:00")
  });
  const regularOnly = calculateBudgetSnapshot({
    todayTotal: 500,
    monthTotal: 7000,
    monthlyBudget: 45000,
    now: new Date("2026-06-10T10:00:00+07:00")
  });

  assert.equal(withPlanned.averageDailyRegularSpending, regularOnly.averageDailyRegularSpending);
});

test("averageDailyRegularSpending display excludes non-daily impacts", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 500,
    todayDisplayTotal: 15,
    monthTotal: 10000,
    monthDisplayTotal: 300,
    monthlyBudget: 45000,
    paidPlannedMonthTotal: 3000,
    paidPlannedMonthDisplayTotal: 90,
    largeOneOffMonthTotal: 2000,
    largeOneOffMonthDisplayTotal: 60,
    displayCurrency: "USD",
    now: new Date("2026-06-10T10:00:00+07:00")
  });

  assert.equal(snapshot.display.averageDailyRegularSpending, 15);
});

test("subtracts reserve from regular spending availability and reports reserve state", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 1000,
    monthTotal: 45000,
    monthlyBudget: 60000,
    plannedRemainingTotal: 12500,
    reserveAmount: 4000,
    paidPlannedMonthTotal: 0,
    now: new Date("2026-06-10T10:00:00+07:00")
  });

  assert.equal(snapshot.freeRemaining, 0);
  assert.equal(snapshot.availableRegular, 43500);
  assert.equal(snapshot.reserve.amount, 4000);
  assert.equal(snapshot.reserve.savedAmount, 2500);
  assert.equal(snapshot.reserve.eatenAmount, 1500);
  assert.equal(snapshot.reserve.status, "partially_used");
});

test("uses the full calendar month for the stable daily plan limit", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 383,
    monthTotal: 42811,
    monthlyBudget: 48000,
    plannedRemainingTotal: 1977,
    now: new Date("2026-06-23T10:00:00+07:00")
  });

  assert.equal(snapshot.dayPlanLimit, 1600);
  assert.equal(snapshot.dayRemaining, 1217);
  assert.equal(snapshot.safeToSpendPerDay, 401.5);
  assert.notEqual(snapshot.dayPlanLimit, 784.5);
});

test("uses the original partial-month period for the stable daily plan limit", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 0,
    monthTotal: 0,
    monthlyBudget: 30000,
    dayPlanDays: 19,
    now: new Date("2026-06-23T10:00:00+07:00")
  });

  assert.equal(snapshot.dayPlanLimit, 1578.95);
  assert.notEqual(snapshot.dayPlanLimit, 3750);
});

test("does not increase the daily plan limit when today's spending increases", () => {
  const limits = [0, 383, 1000].map((todayTotal) => calculateBudgetSnapshot({
    todayTotal,
    monthTotal: todayTotal,
    monthlyBudget: 48000,
    now: new Date("2026-06-23T10:00:00+07:00")
  }).dayPlanLimit);

  assert.deepEqual(limits, [1600, 1600, 1600]);
});
