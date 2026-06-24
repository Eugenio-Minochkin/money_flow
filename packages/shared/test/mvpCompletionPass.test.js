import test from "node:test";
import assert from "node:assert/strict";

import { calculateBudgetSnapshot } from "../src/budget.js";

test("MVP pass: new Bangkok month has stable day and month expected values", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 200,
    weekTotal: 200,
    monthTotal: 200,
    monthlyBudget: 31000,
    timeZone: "Asia/Bangkok",
    now: new Date("2026-06-30T18:10:00.000Z")
  });

  assert.equal(snapshot.daysInMonth, 31);
  assert.equal(snapshot.elapsedDaysInMonth, 1);
  assert.equal(snapshot.daysLeftInMonth, 31);
  assert.equal(snapshot.today, 200);
  assert.equal(snapshot.week, 200);
  assert.equal(snapshot.month, 200);
  assert.equal(snapshot.monthlyBudget, 31000);
  assert.equal(snapshot.monthRemaining, 30800);
  assert.equal(snapshot.plannedRemaining, 0);
  assert.equal(snapshot.freeRemaining, 30800);
  assert.equal(snapshot.dailyPlanLimit, 1000);
  assert.equal(snapshot.safeToSpendPerDay, 993.55);
  assert.equal(snapshot.dayPlanLimit, 993.55);
  assert.equal(snapshot.dayRemaining, 793.55);
  assert.equal(snapshot.forecastMonthTotal, 6200);
});

test("MVP pass: mid-month current budget override keeps explicit expected values", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 500,
    weekTotal: 1500,
    monthTotal: 3000,
    monthlyBudget: 12000,
    dayPlanDays: 19,
    plannedRemainingTotal: 2000,
    timeZone: "Asia/Bangkok",
    now: new Date("2026-06-23T10:00:00+07:00")
  });

  assert.equal(snapshot.daysInMonth, 30);
  assert.equal(snapshot.elapsedDaysInMonth, 23);
  assert.equal(snapshot.daysLeftInMonth, 8);
  assert.equal(snapshot.today, 500);
  assert.equal(snapshot.week, 1500);
  assert.equal(snapshot.month, 3000);
  assert.equal(snapshot.monthlyBudget, 12000);
  assert.equal(snapshot.monthRemaining, 9000);
  assert.equal(snapshot.plannedRemaining, 2000);
  assert.equal(snapshot.freeRemaining, 7000);
  assert.equal(snapshot.dailyPlanLimit, 631.58);
  assert.equal(snapshot.safeToSpendPerDay, 875);
  assert.equal(snapshot.dayPlanLimit, 875);
  assert.equal(snapshot.dayRemaining, 375);
  assert.equal(snapshot.forecastMonthTotal, 5913.04);
});

test("MVP pass: fixed daily budget for local day remains fixed while live pace is tracked", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 383,
    weekTotal: 1200,
    monthTotal: 42811,
    monthlyBudget: 48000,
    plannedRemainingTotal: 1977,
    dayPlanLimit: 401.5,
    timeZone: "Asia/Bangkok",
    now: new Date("2026-06-23T10:00:00+07:00")
  });

  assert.equal(snapshot.today, 383);
  assert.equal(snapshot.week, 1200);
  assert.equal(snapshot.month, 42811);
  assert.equal(snapshot.plannedRemaining, 1977);
  assert.equal(snapshot.freeRemaining, 3212);
  assert.equal(snapshot.safeToSpendPerDay, 401.5);
  assert.equal(snapshot.dayPlanLimit, 401.5);
  assert.equal(snapshot.dayRemaining, 18.5);
  assert.equal(snapshot.dayOverrun, 0);
  assert.equal(snapshot.forecastMonthTotal, 57817.43);
});

test("MVP pass: planned and large one-off expenses do not inflate regular daily pace", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 802,
    weekTotal: 4300,
    monthTotal: 12802,
    monthlyBudget: 42000,
    plannedRemainingTotal: 10000,
    paidPlannedMonthTotal: 1000,
    largeOneOffMonthTotal: 2000,
    timeZone: "Asia/Bangkok",
    now: new Date("2026-06-06T20:00:00+07:00")
  });

  assert.equal(snapshot.today, 802);
  assert.equal(snapshot.week, 4300);
  assert.equal(snapshot.month, 12802);
  assert.equal(snapshot.monthRemaining, 29198);
  assert.equal(snapshot.plannedRemaining, 10000);
  assert.equal(snapshot.freeRemaining, 19198);
  assert.equal(snapshot.averageDailyRegularSpending, 1633.67);
  assert.equal(snapshot.forecastMonthTotal, 62010);
});

test("MVP pass: active reserve expected values stay separate from planned and large one-off pace", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 1000,
    weekTotal: 5000,
    monthTotal: 45000,
    monthlyBudget: 60000,
    plannedRemainingTotal: 12500,
    paidPlannedMonthTotal: 3000,
    largeOneOffMonthTotal: 2000,
    reserveAmount: 4000,
    timeZone: "Asia/Bangkok",
    now: new Date("2026-06-10T10:00:00+07:00")
  });

  assert.equal(snapshot.today, 1000);
  assert.equal(snapshot.week, 5000);
  assert.equal(snapshot.month, 45000);
  assert.equal(snapshot.monthRemaining, 15000);
  assert.equal(snapshot.plannedRemaining, 12500);
  assert.equal(snapshot.freeRemaining, 0);
  assert.equal(snapshot.averageDailyRegularSpending, 4000);
  assert.equal(snapshot.forecastMonthTotal, 137500);
  assert.equal(snapshot.availableRegular, 40500);
  assert.equal(snapshot.reserve.amount, 4000);
  assert.equal(snapshot.reserve.savedAmount, 4000);
  assert.equal(snapshot.reserve.eatenAmount, 0);
  assert.equal(snapshot.reserve.status, "saved");
});
