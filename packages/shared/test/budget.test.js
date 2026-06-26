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
    reservedAhead: 0,
    freeRemaining: 16500,
    budgetProgressPercent: 63.33,
    daysInMonth: 30,
    elapsedDaysInMonth: 7,
    daysLeftInMonth: 24,
    daysInWeek: 7,
    elapsedDaysInWeek: 7,
    dailyPlanLimit: 1500,
    dayPlanLimit: 687.5,
    dayRemaining: 0,
    dayOverrun: 132.5,
    dayProgressPercent: 119.27,
    weeklyBudget: 10500,
    weekPlanLimit: 10500,
    plannedThisWeek: 0,
    weekRemaining: 10500,
    weekRemainingRaw: 10500,
    weekAvailable: 10500,
    isMonthBinding: false,
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
      day: { percent: 119.27, state: "danger" },
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
      reservedAhead: 0,
      reserveAmount: 0,
      freeRemaining: 0,
      dailyPlanLimit: 0,
      dayPlanLimit: 0,
      dayRemaining: 0,
      dayOverrun: 0,
      weeklyBudget: 0,
      weekPlanLimit: 0,
      plannedThisWeek: 0,
      weekRemaining: 0,
      weekRemainingRaw: 0,
      weekAvailable: 0,
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

  assert.equal(snapshot.dayPlanLimit, 1247.62);
  assert.equal(snapshot.dayRemaining, 597.62);
  assert.equal(snapshot.dayProgressPercent, 52.1);
  assert.equal(snapshot.weekPlanLimit, 11250);
  assert.equal(snapshot.plannedThisWeek, 1000);
  assert.equal(snapshot.weekRemaining, 6900);
  assert.equal(snapshot.weekProgressPercent, 29.78);
  assert.equal(snapshot.monthRemaining, 26200);
  assert.deepEqual(snapshot.progress.day, { percent: 52.1, state: "good" });
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

  assert.equal(snapshot.freeRemaining, -1500);
  assert.equal(snapshot.availableRegular, 43500);
  assert.equal(snapshot.reserve.amount, 4000);
  assert.equal(snapshot.reserve.savedAmount, 2500);
  assert.equal(snapshot.reserve.eatenAmount, 1500);
  assert.equal(snapshot.reserve.status, "partially_used");
});

test("calculates month-free and clamps week availability by month", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 676,
    weekTotal: 3813,
    monthTotal: 45481,
    monthlyBudget: 48000,
    weeklyBudget: 11200,
    plannedRemainingTotal: 712,
    reserveAmount: 0,
    dayPlanLimit: 397,
    now: new Date("2026-06-25T12:00:00+07:00"),
    timeZone: "Asia/Bangkok"
  });

  assert.equal(snapshot.monthRemaining, 2519);
  assert.equal(snapshot.reservedAhead, 712);
  assert.equal(snapshot.freeRemaining, 1807);
  assert.equal(snapshot.weekRemainingRaw, 7387);
  assert.equal(snapshot.weekAvailable, 1807);
  assert.equal(snapshot.isMonthBinding, true);
  assert.equal(snapshot.dayOverrun, 279);
  assert.equal(snapshot.dayRemaining, 0);
});

test("uses provided dashboard display values instead of the monthly spending ratio", () => {
  const displayFromBase = (amount) => Math.round(((amount / 32.65) + Number.EPSILON) * 100) / 100;
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 676,
    todayDisplayTotal: displayFromBase(676),
    weekTotal: 3813,
    weekDisplayTotal: displayFromBase(3813),
    monthTotal: 45481,
    monthDisplayTotal: 9999,
    monthlyBudget: 48000,
    monthlyBudgetDisplay: displayFromBase(48000),
    weeklyBudget: 11200,
    weeklyBudgetDisplay: displayFromBase(11200),
    plannedRemainingTotal: 712,
    plannedRemainingDisplayTotal: displayFromBase(712),
    reservedAheadDisplay: displayFromBase(712),
    reserveAmount: 0,
    reserveDisplayAmount: 0,
    monthRemainingDisplay: displayFromBase(2519),
    freeRemainingDisplay: displayFromBase(1807),
    weekRemainingRawDisplay: displayFromBase(7387),
    weekAvailableDisplay: displayFromBase(1807),
    dayPlanLimit: 397,
    dayDisplayPlanLimit: displayFromBase(397),
    now: new Date("2026-06-25T12:00:00+07:00"),
    timeZone: "Asia/Bangkok"
  });

  assert.equal(snapshot.dayOverrun, 279);
  assert.equal(snapshot.freeRemaining, 1807);
  assert.equal(snapshot.display.freeRemaining, displayFromBase(1807));
  assert.equal(snapshot.display.weekAvailable, displayFromBase(1807));
  assert.equal(snapshot.display.weekRemainingRaw, displayFromBase(7387));
  assert.equal(snapshot.display.monthRemaining, displayFromBase(2519));
  assert.equal(snapshot.display.monthlyBudget, displayFromBase(48000));
  assert.equal(snapshot.display.weeklyBudget, displayFromBase(11200));
});

test("does not subtract planned payments twice from week availability", () => {
  const snapshot = calculateBudgetSnapshot({
    weekTotal: 3000,
    monthlyBudget: 50000,
    monthTotal: 10000,
    weeklyBudget: 10000,
    plannedRemainingTotal: 5000,
    plannedThisWeekTotal: 2000,
    now: new Date("2026-06-10T12:00:00+07:00"),
    timeZone: "Asia/Bangkok"
  });

  assert.equal(snapshot.weekRemainingRaw, 7000);
  assert.equal(snapshot.weekAvailable, 7000);
});

test("keeps negative free remaining when obligations exceed month remaining", () => {
  const snapshot = calculateBudgetSnapshot({
    monthTotal: 9500,
    monthlyBudget: 10000,
    plannedRemainingTotal: 1000,
    reserveAmount: 0,
    now: new Date("2026-06-20T12:00:00+07:00"),
    timeZone: "Asia/Bangkok"
  });

  assert.equal(snapshot.monthRemaining, 500);
  assert.equal(snapshot.freeRemaining, -500);
});

test("subtracts active reserve from month free amount", () => {
  const snapshot = calculateBudgetSnapshot({
    monthTotal: 30000,
    monthlyBudget: 50000,
    plannedRemainingTotal: 5000,
    reserveAmount: 4000,
    now: new Date("2026-06-15T12:00:00+07:00"),
    timeZone: "Asia/Bangkok"
  });

  assert.equal(snapshot.monthRemaining, 20000);
  assert.equal(snapshot.reservedAhead, 9000);
  assert.equal(snapshot.freeRemaining, 11000);
});

test("falls back to live safe-to-spend when no fixed daily snapshot is provided", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 383,
    monthTotal: 42811,
    monthlyBudget: 48000,
    plannedRemainingTotal: 1977,
    now: new Date("2026-06-23T10:00:00+07:00")
  });

  assert.equal(snapshot.dailyPlanLimit, 1600);
  assert.equal(snapshot.dayPlanLimit, 401.5);
  assert.equal(snapshot.dayRemaining, 18.5);
  assert.equal(snapshot.safeToSpendPerDay, 401.5);
  assert.notEqual(snapshot.dayPlanLimit, 1600);
});

test("uses the original partial-month period only for the analytical daily plan limit", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 0,
    monthTotal: 0,
    monthlyBudget: 30000,
    dayPlanDays: 19,
    now: new Date("2026-06-23T10:00:00+07:00")
  });

  assert.equal(snapshot.dailyPlanLimit, 1578.95);
  assert.notEqual(snapshot.dailyPlanLimit, 1000);
});

test("keeps a fixed daily budget stable while today's spending reduces the remainder", () => {
  const results = [0, 383, 1000].map((todayTotal) => calculateBudgetSnapshot({
    todayTotal,
    monthTotal: 42811 + todayTotal,
    monthlyBudget: 48000,
    plannedRemainingTotal: 1977,
    dayPlanLimit: 401.5,
    now: new Date("2026-06-23T10:00:00+07:00")
  }));

  assert.deepEqual(results.map((snapshot) => snapshot.dayPlanLimit), [401.5, 401.5, 401.5]);
  assert.deepEqual(results.map((snapshot) => snapshot.dayRemaining), [401.5, 18.5, 0]);
  assert.deepEqual(results.map((snapshot) => snapshot.dayOverrun), [0, 0, 598.5]);
});

test("calculates elapsed month and week days in the user's timezone", () => {
  const instant = new Date("2026-06-30T17:30:00Z");
  const bangkok = calculateBudgetSnapshot({
    todayTotal: 0,
    monthTotal: 0,
    monthlyBudget: 31000,
    now: instant,
    timeZone: "Asia/Bangkok"
  });
  const newYork = calculateBudgetSnapshot({
    todayTotal: 0,
    monthTotal: 0,
    monthlyBudget: 30000,
    now: instant,
    timeZone: "America/New_York"
  });

  assert.equal(bangkok.daysInMonth, 31);
  assert.equal(bangkok.elapsedDaysInMonth, 1);
  assert.equal(bangkok.elapsedDaysInWeek, 3);
  assert.equal(newYork.daysInMonth, 30);
  assert.equal(newYork.elapsedDaysInMonth, 30);
  assert.equal(newYork.elapsedDaysInWeek, 2);
});
