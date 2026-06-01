import { monthDaysLeft } from "./time.js";

export function calculateBudgetSnapshot({
  todayTotal,
  weekTotal = 0,
  monthTotal,
  monthlyBudget,
  plannedRemainingTotal = 0,
  now
}) {
  const remaining = monthlyBudget - monthTotal;
  const freeRemaining = remaining - plannedRemainingTotal;
  const daysLeftInMonth = monthDaysLeft(now);
  const safeToSpendPerDay = roundMoney(Math.max(freeRemaining, 0) / daysLeftInMonth);

  return {
    today: roundMoney(todayTotal),
    week: roundMoney(weekTotal),
    month: roundMoney(monthTotal),
    monthlyBudget: roundMoney(monthlyBudget),
    remaining: roundMoney(remaining),
    plannedRemaining: roundMoney(plannedRemainingTotal),
    freeRemaining: roundMoney(freeRemaining),
    daysLeftInMonth,
    safeToSpendPerDay,
    status: budgetStatus({ monthTotal, monthlyBudget, now })
  };
}

function budgetStatus({ monthTotal, monthlyBudget, now }) {
  const elapsedDays = elapsedMonthDays(now);
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const plannedSpend = monthlyBudget * (elapsedDays / daysInMonth);
  if (monthTotal > plannedSpend * 1.08) return "above_plan";
  if (monthTotal < plannedSpend * 0.92) return "below_plan";
  return "on_plan";
}

function elapsedMonthDays(date) {
  const local = new Date(date.getTime() + 7 * 60 * 60_000);
  return local.getUTCDate();
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
