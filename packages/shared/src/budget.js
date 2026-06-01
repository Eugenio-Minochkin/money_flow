import { monthDaysLeft } from "./time.js";

export function calculateBudgetSnapshot({
  todayTotal,
  weekTotal = 0,
  monthTotal,
  monthlyBudget,
  plannedRemainingTotal = 0,
  todayDisplayTotal = 0,
  weekDisplayTotal = 0,
  monthDisplayTotal = 0,
  plannedRemainingDisplayTotal = 0,
  displayCurrency = "USD",
  now
}) {
  const remaining = monthlyBudget - monthTotal;
  const freeRemaining = remaining - plannedRemainingTotal;
  const freeRemainingDisplay = Math.max(monthDisplayTotal, 0) === 0 && monthTotal === 0
    ? 0
    : Math.max(displayFromBase(freeRemaining, monthTotal, monthDisplayTotal), 0);
  const daysLeftInMonth = monthDaysLeft(now);
  const safeToSpendPerDay = roundMoney(Math.max(freeRemaining, 0) / daysLeftInMonth);
  const safeToSpendDisplayPerDay = roundMoney(freeRemainingDisplay / daysLeftInMonth);

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
    display: {
      currency: displayCurrency,
      today: roundMoney(todayDisplayTotal),
      week: roundMoney(weekDisplayTotal),
      month: roundMoney(monthDisplayTotal),
      plannedRemaining: roundMoney(plannedRemainingDisplayTotal),
      freeRemaining: roundMoney(freeRemainingDisplay),
      safeToSpendPerDay: safeToSpendDisplayPerDay
    },
    status: budgetStatus({ monthTotal, monthlyBudget, now })
  };
}

function displayFromBase(value, baseTotal, displayTotal) {
  if (!baseTotal) return 0;
  return value * (displayTotal / baseTotal);
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
