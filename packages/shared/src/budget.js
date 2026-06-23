import { monthDaysLeft, timeZoneMonthState } from "./time.js";
import { calculateReserveForecast, calculateReserveState } from "./reserve.js";

export function calculateBudgetSnapshot({
  todayTotal,
  weekTotal = 0,
  monthTotal,
  monthlyBudget,
  weeklyBudget = null,
  plannedRemainingTotal = 0,
  plannedThisWeekTotal = 0,
  paidPlannedMonthTotal = 0,
  largeOneOffMonthTotal = 0,
  paidPlannedMonthDisplayTotal = 0,
  largeOneOffMonthDisplayTotal = 0,
  todayDisplayTotal = 0,
  weekDisplayTotal = 0,
  monthDisplayTotal = 0,
  plannedRemainingDisplayTotal = 0,
  plannedThisWeekDisplayTotal = 0,
  reserveAmount = 0,
  dayPlanLimit: fixedDayPlanLimit = null,
  dayDisplayPlanLimit: fixedDayDisplayPlanLimit = null,
  dayPlanDays = null,
  baseCurrency = "THB",
  displayCurrency = "USD",
  budgetAdviceEnabled = true,
  timeZone = null,
  now
}) {
  const remaining = monthlyBudget - monthTotal;
  const budgetProgressPercent = monthlyBudget > 0 ? roundMoney((monthTotal / monthlyBudget) * 100) : 0;
  const reserve = Math.max(Number(reserveAmount ?? 0), 0);
  const freeRemaining = Math.max(remaining - plannedRemainingTotal - reserve, 0);
  const freeRemainingDisplay = Math.max(monthDisplayTotal, 0) === 0 && monthTotal === 0
    ? 0
    : Math.max(displayFromBase(freeRemaining, monthTotal, monthDisplayTotal), 0);
  const monthState = timeZone ? timeZoneMonthState(now, timeZone) : null;
  const daysLeftInMonth = monthState?.remainingDays ?? monthDaysLeft(now);
  const elapsedDaysInMonth = monthState?.dayOfMonth ?? elapsedMonthDays(now);
  const daysInMonth = monthState?.daysInMonth ?? monthDays(now);
  const resolvedDayPlanDays = Number.isFinite(Number(dayPlanDays)) && Number(dayPlanDays) > 0
    ? Number(dayPlanDays)
    : daysInMonth;
  const daysInWeek = 7;
  const elapsedDaysInWeek = elapsedWeekDays(now);
  const dailyPlanLimit = roundMoney(monthlyBudget / resolvedDayPlanDays);
  const dailyPlanDisplayLimit = roundMoney(displayFromBase(dailyPlanLimit, monthTotal, monthDisplayTotal));
  const resolvedWeeklyBudget = roundMoney(resolveWeeklyBudget({ monthlyBudget, weeklyBudget, daysInMonth }));
  const nonDailyMonthTotal = Number(paidPlannedMonthTotal ?? 0) + Number(largeOneOffMonthTotal ?? 0);
  const regularMonthTotal = Math.max(monthTotal - nonDailyMonthTotal, 0);
  const plannedMonthTotal = Number(paidPlannedMonthTotal ?? 0) + Number(plannedRemainingTotal ?? 0);
  const reserveState = reserve > 0
    ? calculateReserveState({
        budgetAmount: monthlyBudget,
        plannedAmount: plannedMonthTotal,
        reserveAmount: reserve,
        regularSpentAmount: regularMonthTotal
      })
    : null;
  const reserveForecast = reserve > 0
    ? calculateReserveForecast({
        dayOfMonth: elapsedDaysInMonth,
        daysInMonth,
        regularSpentAmount: regularMonthTotal,
        budgetAmount: monthlyBudget,
        plannedAmount: plannedMonthTotal,
        reserveAmount: reserve
      })
    : null;
  const averageDailyRegularSpending = elapsedDaysInMonth > 0
    ? roundMoney(regularMonthTotal / elapsedDaysInMonth)
    : 0;
  const forecastMonthTotal = roundMoney((regularMonthTotal / elapsedDaysInMonth) * daysInMonth + nonDailyMonthTotal + plannedRemainingTotal);
  const plannedSpendToDate = monthlyBudget * (elapsedDaysInMonth / daysInMonth);
  const planDeviation = roundMoney(monthTotal - plannedSpendToDate);
  const safeToSpendPerDay = roundMoney(Math.max(freeRemaining, 0) / daysLeftInMonth);
  const safeToSpendDisplayPerDay = roundMoney(freeRemainingDisplay / daysLeftInMonth);
  const dayPlanLimit = fixedDayPlanLimit == null
    ? dailyPlanLimit
    : roundMoney(Number(fixedDayPlanLimit));
  const dayRemaining = roundMoney(Math.max(dayPlanLimit - todayTotal, 0));
  const dayOverrun = roundMoney(Math.max(todayTotal - dayPlanLimit, 0));
  const dayDisplayPlanLimit = fixedDayDisplayPlanLimit == null
    ? dailyPlanDisplayLimit
    : roundMoney(Number(fixedDayDisplayPlanLimit));
  const dayDisplayRemaining = roundMoney(Math.max(dayDisplayPlanLimit - todayDisplayTotal, 0));
  const dayDisplayOverrun = roundMoney(Math.max(todayDisplayTotal - dayDisplayPlanLimit, 0));
  const dayProgressPercent = percent(todayTotal, dayPlanLimit);
  const weekPlanLimit = resolvedWeeklyBudget;
  const plannedThisWeek = roundMoney(plannedThisWeekTotal);
  const weekRemaining = roundMoney(Math.max(weekPlanLimit - weekTotal - plannedThisWeek, 0));
  const weekProgressPercent = percent(weekTotal, weekPlanLimit);
  const monthRemaining = roundMoney(Math.max(remaining, 0));
  const monthlyBudgetDisplay = roundMoney(displayFromBase(monthlyBudget, monthTotal, monthDisplayTotal));
  const weeklyBudgetDisplay = roundMoney(displayFromBase(resolvedWeeklyBudget, monthTotal, monthDisplayTotal));
  const plannedThisWeekDisplay = roundMoney(plannedThisWeekDisplayTotal);
  const weekDisplayPlanLimit = weeklyBudgetDisplay;
  const weekDisplayRemaining = roundMoney(Math.max(weekDisplayPlanLimit - weekDisplayTotal - plannedThisWeekDisplay, 0));
  const monthDisplayRemaining = roundMoney(Math.max(displayFromBase(monthRemaining, monthTotal, monthDisplayTotal), 0));
  const forecastDisplayMonthTotal = roundMoney(displayFromBase(forecastMonthTotal, monthTotal, monthDisplayTotal));
  const planDisplayDeviation = roundMoney(displayFromBase(planDeviation, monthTotal, monthDisplayTotal));
  const nonDailyDisplayMonthTotal = Number(paidPlannedMonthDisplayTotal ?? 0) + Number(largeOneOffMonthDisplayTotal ?? 0);
  const regularDisplayMonthTotal = Math.max(monthDisplayTotal - nonDailyDisplayMonthTotal, 0);
  const averageDailyRegularDisplaySpending = elapsedDaysInMonth > 0
    ? roundMoney(regularDisplayMonthTotal / elapsedDaysInMonth)
    : 0;
  const progress = {
    day: { percent: dayProgressPercent, state: simpleProgressState(dayProgressPercent) },
    week: { percent: weekProgressPercent, state: pacedProgressState(weekProgressPercent, elapsedDaysInWeek, daysInWeek) },
    month: { percent: budgetProgressPercent, state: pacedProgressState(budgetProgressPercent, elapsedDaysInMonth, daysInMonth) }
  };
  const recoveryAdvice = buildRecoveryAdvice({
    budgetAdviceEnabled,
    monthlyBudget,
    monthTotal,
    monthDisplayTotal,
    forecastMonthTotal,
    freeRemaining,
    safeToSpendPerDay,
    daysLeftInMonth,
    todayTotal,
    todayDisplayTotal,
    dayPlanLimit,
    dayDisplayPlanLimit,
    displayCurrency
  });

  return {
    today: roundMoney(todayTotal),
    week: roundMoney(weekTotal),
    month: roundMoney(monthTotal),
    baseCurrency,
    monthlyBudget: roundMoney(monthlyBudget),
    remaining: roundMoney(remaining),
    plannedRemaining: roundMoney(plannedRemainingTotal),
    freeRemaining: roundMoney(freeRemaining),
    ...(reserveState ? {
      availableRegular: reserveState.availableRegular,
      reserve: {
        amount: roundMoney(reserve),
        ...reserveState,
        forecast: reserveForecast
      }
    } : {}),
    budgetProgressPercent,
    daysInMonth,
    elapsedDaysInMonth,
    daysLeftInMonth,
    daysInWeek,
    elapsedDaysInWeek,
    dailyPlanLimit,
    dayPlanLimit,
    dayRemaining,
    dayOverrun,
    dayProgressPercent,
    weeklyBudget: resolvedWeeklyBudget,
    weekPlanLimit,
    plannedThisWeek,
    weekRemaining,
    weekProgressPercent,
    monthRemaining,
    forecastMonthTotal,
    averageDailyRegularSpending,
    planDeviation,
    safeToSpendPerDay,
    recoveryAdvice,
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
      dayRemaining: dayDisplayRemaining,
      dayOverrun: dayDisplayOverrun,
      weeklyBudget: weeklyBudgetDisplay,
      weekPlanLimit: weekDisplayPlanLimit,
      plannedThisWeek: plannedThisWeekDisplay,
      weekRemaining: weekDisplayRemaining,
      monthRemaining: monthDisplayRemaining,
      forecastMonthTotal: forecastDisplayMonthTotal,
      averageDailyRegularSpending: averageDailyRegularDisplaySpending,
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

function buildRecoveryAdvice({
  budgetAdviceEnabled,
  monthlyBudget,
  monthTotal,
  monthDisplayTotal,
  forecastMonthTotal,
  freeRemaining,
  safeToSpendPerDay,
  daysLeftInMonth,
  todayTotal,
  todayDisplayTotal,
  dayPlanLimit,
  dayDisplayPlanLimit,
  displayCurrency
}) {
  const forecastOverBudget = roundMoney(forecastMonthTotal - monthlyBudget);
  const overPercent = monthlyBudget > 0 ? (forecastOverBudget / monthlyBudget) * 100 : 0;
  const active = Boolean(budgetAdviceEnabled) && forecastOverBudget > 0 && overPercent >= 5;
  const state = overPercent >= 15 ? "danger" : overPercent >= 5 ? "warn" : "good";
  return {
    active,
    state,
    overPercent: roundMoney(Math.max(overPercent, 0)),
    forecastOverBudget: roundMoney(Math.max(forecastOverBudget, 0)),
    requiredPerDay: roundMoney(Math.max(safeToSpendPerDay, 0)),
    todayTarget: roundMoney(Math.max(Math.min(safeToSpendPerDay, freeRemaining), 0)),
    display: {
      currency: displayCurrency,
      forecastOverBudget: roundMoney(Math.max(displayFromBase(forecastOverBudget, monthTotal, monthDisplayTotal), 0)),
      requiredPerDay: roundMoney(Math.max(displayFromBase(safeToSpendPerDay, monthTotal, monthDisplayTotal), 0)),
      todayTarget: roundMoney(Math.max(displayFromBase(Math.min(safeToSpendPerDay, freeRemaining), monthTotal, monthDisplayTotal), 0)),
      today: roundMoney(todayDisplayTotal),
      dayPlanLimit: roundMoney(dayDisplayPlanLimit)
    },
    daysLeftInMonth
  };
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
