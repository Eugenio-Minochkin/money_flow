import { monthDaysLeft } from "./time.js";

export function calculateBudgetSnapshot({
  todayTotal,
  weekTotal = 0,
  monthTotal,
  monthlyBudget,
  weeklyBudget = null,
  plannedRemainingTotal = 0,
  plannedThisWeekTotal = 0,
  todayDisplayTotal = 0,
  weekDisplayTotal = 0,
  monthDisplayTotal = 0,
  plannedRemainingDisplayTotal = 0,
  plannedThisWeekDisplayTotal = 0,
  displayCurrency = "USD",
  now
}) {
  const remaining = monthlyBudget - monthTotal;
  const budgetProgressPercent = monthlyBudget > 0 ? roundMoney((monthTotal / monthlyBudget) * 100) : 0;
  const freeRemaining = remaining - plannedRemainingTotal;
  const freeRemainingDisplay = Math.max(monthDisplayTotal, 0) === 0 && monthTotal === 0
    ? 0
    : Math.max(displayFromBase(freeRemaining, monthTotal, monthDisplayTotal), 0);
  const daysLeftInMonth = monthDaysLeft(now);
  const elapsedDaysInMonth = elapsedMonthDays(now);
  const daysInMonth = monthDays(now);
  const daysInWeek = 7;
  const elapsedDaysInWeek = elapsedWeekDays(now);
  const dailyPlanLimit = roundMoney(monthlyBudget / daysInMonth);
  const resolvedWeeklyBudget = roundMoney(resolveWeeklyBudget({ monthlyBudget, weeklyBudget, daysInMonth }));
  const forecastMonthTotal = roundMoney((monthTotal / elapsedDaysInMonth) * daysInMonth);
  const plannedSpendToDate = monthlyBudget * (elapsedDaysInMonth / daysInMonth);
  const planDeviation = roundMoney(monthTotal - plannedSpendToDate);
  const safeToSpendPerDay = roundMoney(Math.max(freeRemaining, 0) / daysLeftInMonth);
  const safeToSpendDisplayPerDay = roundMoney(freeRemainingDisplay / daysLeftInMonth);
  const dayPlanLimit = roundMoney(todayTotal + safeToSpendPerDay);
  const dayDisplayPlanLimit = roundMoney(todayDisplayTotal + safeToSpendDisplayPerDay);
  const dayProgressPercent = percent(todayTotal, dayPlanLimit);
  const weekPlanLimit = resolvedWeeklyBudget;
  const plannedThisWeek = roundMoney(plannedThisWeekTotal);
  const weekRemaining = roundMoney(Math.max(weekPlanLimit - weekTotal - plannedThisWeek, 0));
  const weekProgressPercent = percent(weekTotal, weekPlanLimit);
  const monthRemaining = roundMoney(Math.max(remaining, 0));
  const dailyPlanDisplayLimit = roundMoney(displayFromBase(dailyPlanLimit, monthTotal, monthDisplayTotal));
  const monthlyBudgetDisplay = roundMoney(displayFromBase(monthlyBudget, monthTotal, monthDisplayTotal));
  const weeklyBudgetDisplay = roundMoney(displayFromBase(resolvedWeeklyBudget, monthTotal, monthDisplayTotal));
  const plannedThisWeekDisplay = roundMoney(plannedThisWeekDisplayTotal);
  const weekDisplayPlanLimit = weeklyBudgetDisplay;
  const weekDisplayRemaining = roundMoney(Math.max(weekDisplayPlanLimit - weekDisplayTotal - plannedThisWeekDisplay, 0));
  const monthDisplayRemaining = roundMoney(Math.max(displayFromBase(monthRemaining, monthTotal, monthDisplayTotal), 0));
  const forecastDisplayMonthTotal = roundMoney(displayFromBase(forecastMonthTotal, monthTotal, monthDisplayTotal));
  const planDisplayDeviation = roundMoney(displayFromBase(planDeviation, monthTotal, monthDisplayTotal));
  const progress = {
    day: { percent: dayProgressPercent, state: simpleProgressState(dayProgressPercent) },
    week: { percent: weekProgressPercent, state: pacedProgressState(weekProgressPercent, elapsedDaysInWeek, daysInWeek) },
    month: { percent: budgetProgressPercent, state: pacedProgressState(budgetProgressPercent, elapsedDaysInMonth, daysInMonth) }
  };

  return {
    today: roundMoney(todayTotal),
    week: roundMoney(weekTotal),
    month: roundMoney(monthTotal),
    monthlyBudget: roundMoney(monthlyBudget),
    remaining: roundMoney(remaining),
    plannedRemaining: roundMoney(plannedRemainingTotal),
    freeRemaining: roundMoney(freeRemaining),
    budgetProgressPercent,
    daysInMonth,
    elapsedDaysInMonth,
    daysLeftInMonth,
    daysInWeek,
    elapsedDaysInWeek,
    dailyPlanLimit,
    dayPlanLimit,
    dayRemaining: safeToSpendPerDay,
    dayProgressPercent,
    weeklyBudget: resolvedWeeklyBudget,
    weekPlanLimit,
    plannedThisWeek,
    weekRemaining,
    weekProgressPercent,
    monthRemaining,
    forecastMonthTotal,
    planDeviation,
    safeToSpendPerDay,
    progress,
    display: {
      currency: displayCurrency,
      today: roundMoney(todayDisplayTotal),
      week: roundMoney(weekDisplayTotal),
      month: roundMoney(monthDisplayTotal),
      monthlyBudget: monthlyBudgetDisplay,
      plannedRemaining: roundMoney(plannedRemainingDisplayTotal),
      freeRemaining: roundMoney(freeRemainingDisplay),
      dailyPlanLimit: dailyPlanDisplayLimit,
      dayPlanLimit: dayDisplayPlanLimit,
      dayRemaining: safeToSpendDisplayPerDay,
      weeklyBudget: weeklyBudgetDisplay,
      weekPlanLimit: weekDisplayPlanLimit,
      plannedThisWeek: plannedThisWeekDisplay,
      weekRemaining: weekDisplayRemaining,
      monthRemaining: monthDisplayRemaining,
      forecastMonthTotal: forecastDisplayMonthTotal,
      planDeviation: planDisplayDeviation,
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
  const daysInMonth = monthDays(now);
  const plannedSpend = monthlyBudget * (elapsedDays / daysInMonth);
  if (monthTotal > plannedSpend * 1.08) return "above_plan";
  if (monthTotal < plannedSpend * 0.92) return "below_plan";
  return "on_plan";
}

function percent(value, limit) {
  if (!limit || limit <= 0) return 0;
  return roundMoney((Number(value ?? 0) / limit) * 100);
}

function resolveWeeklyBudget({ monthlyBudget, weeklyBudget, daysInMonth }) {
  const manual = Number(weeklyBudget ?? 0);
  if (Number.isFinite(manual) && manual > 0) return manual;
  return monthlyBudget * (7 / daysInMonth);
}

function simpleProgressState(progressPercent) {
  if (progressPercent >= 85) return "danger";
  if (progressPercent >= 65) return "warn";
  return "good";
}

function pacedProgressState(progressPercent, elapsedDays, totalDays) {
  if (progressPercent >= 95) return "danger";
  const expected = totalDays > 0 ? (elapsedDays / totalDays) * 100 : 100;
  if (progressPercent > expected + 25) return "danger";
  if (progressPercent > expected + 10 || progressPercent >= 85) return "warn";
  return "good";
}

function monthDays(date) {
  const local = new Date(date.getTime() + 7 * 60 * 60_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate();
}

function elapsedMonthDays(date) {
  const local = new Date(date.getTime() + 7 * 60 * 60_000);
  return local.getUTCDate();
}

function elapsedWeekDays(date) {
  const local = new Date(date.getTime() + 7 * 60 * 60_000);
  const weekday = local.getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
