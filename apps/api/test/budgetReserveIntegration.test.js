import test from "node:test";
import assert from "node:assert/strict";

import { createRepository } from "../src/repository.js";

test("monthly budget changes invalidate stale daily budget and recalculate planned reserve forecast", async () => {
  const now = new Date("2026-06-24T10:00:00+07:00");
  const state = createBudgetReserveState({
    monthlyBudget: 42000,
    plannedAmount: 2000,
    reserveAmount: 5000,
    regularToday: 100,
    regularWeek: 1000,
    regularMonth: 10000,
    storedDayBudget: 1200
  });
  const repo = createRepository(createBudgetReservePool(state));

  await repo.updateMonthlyBudget(100, 48000, now);
  const dashboard = await repo.dashboard(100, now);

  assert.equal(state.user.monthly_budget_amount, "48000");
  assert.equal(state.daySnapshotDeleted, true);
  assert.equal(state.storedDayBudget, 4442.86);
  assert.equal(dashboard.snapshot.monthlyBudget, 48000);
  assert.equal(dashboard.snapshot.plannedRemaining, 2000);
  assert.equal(dashboard.snapshot.reserve.amount, 5000);
  assert.equal(dashboard.snapshot.reserve.savedAmount, 5000);
  assert.equal(dashboard.snapshot.reserve.eatenAmount, 0);
  assert.equal(dashboard.snapshot.freeRemaining, 31000);
  assert.equal(dashboard.snapshot.safeToSpendPerDay, 4428.57);
  assert.equal(dashboard.snapshot.dayPlanLimit, 4442.86);
  assert.equal(dashboard.snapshot.dayRemaining, 4342.86);
  assert.equal(dashboard.snapshot.forecastMonthTotal, 14500);
  assert.equal(dashboard.snapshot.averageDailyRegularSpending, 416.67);
  assert.equal(dashboard.snapshot.reserve.forecast.forecastRegularSpentAmount, 12500);
  assert.equal(dashboard.snapshot.reserve.forecast.savedAmount, 5000);
});

test("first daily budget snapshot created mid-day uses local day opening baseline", async () => {
  const now = new Date("2026-06-24T15:00:00+07:00");
  const state = createBudgetReserveState({
    monthlyBudget: 45000,
    plannedAmount: 0,
    reserveAmount: 0,
    regularToday: 350,
    largeToday: 5000,
    regularWeek: 350,
    largeWeek: 5000,
    regularMonth: 350,
    largeMonth: 5000,
    storedDayBudget: null
  });
  const repo = createRepository(createBudgetReservePool(state));

  const dashboard = await repo.dashboard(100, now);

  assert.equal(state.storedDayBudget, 5714.29);
  assert.equal(dashboard.snapshot.dayPlanLimit, 5714.29);
  assert.equal(dashboard.snapshot.dayRemaining, 5364.29);
  assert.equal(dashboard.snapshot.largeToday, 5000);
  assert.equal(dashboard.snapshot.month, 5350);
});

test("planned expense changes invalidate daily snapshot and recreate it from opening baseline", async () => {
  const now = new Date("2026-06-24T10:00:00+07:00");
  const state = createBudgetReserveState({
    monthlyBudget: 45000,
    plannedAmount: 2000,
    reserveAmount: 0,
    regularToday: 350,
    regularMonth: 350,
    storedDayBudget: 999
  });
  const repo = createRepository(createBudgetReservePool(state));

  await repo.updatePlannedExpense(100, 5, {
    amount: 4000,
    currency: "THB",
    description: "therapy",
    category_slug: "health",
    tags: [],
    recurrence: "monthly",
    due_day: 30,
    due_days: [30],
    active: true
  }, now);
  const dashboard = await repo.dashboard(100, now);

  assert.equal(state.daySnapshotDeleted, true);
  assert.equal(state.storedDayBudget, 5857.14);
  assert.equal(dashboard.snapshot.plannedRemaining, 4000);
  assert.equal(dashboard.snapshot.dayPlanLimit, 5857.14);
  assert.equal(dashboard.snapshot.dayRemaining, 5507.14);
});

test("paying a planned occurrence keeps the daily snapshot fixed without double subtraction", async () => {
  const now = new Date("2026-06-30T10:00:00+07:00");
  const state = createBudgetReserveState({
    monthlyBudget: 45000,
    plannedAmount: 2000,
    reserveAmount: 0,
    regularToday: 350,
    regularMonth: 350,
    storedDayBudget: 6142.86
  });
  const repo = createRepository(createBudgetReservePool(state));

  await repo.payPlannedExpenseForTelegramUser(5, 100, now, { occurrenceDate: "2026-06-30" });
  const dashboard = await repo.dashboard(100, now);

  assert.equal(state.daySnapshotDeleted, false);
  assert.equal(state.storedDayBudget, 6142.86);
  assert.equal(dashboard.snapshot.plannedRemaining, 0);
  assert.equal(dashboard.snapshot.dayPlanLimit, 6142.86);
  assert.equal(dashboard.snapshot.dayRemaining, 5792.86);
  assert.equal(dashboard.snapshot.plannedToday, 0);
});

test("reserve changes invalidate daily snapshot and recreate it from opening baseline", async () => {
  const now = new Date("2026-06-24T10:00:00+07:00");
  const state = createBudgetReserveState({
    monthlyBudget: 45000,
    plannedAmount: 0,
    reserveAmount: 2000,
    regularToday: 350,
    regularMonth: 350,
    storedDayBudget: 999
  });
  const repo = createRepository(createBudgetReservePool(state));

  await repo.upsertCurrentReserve(100, {
    amount: 5000,
    title: "camera",
    scope: "current"
  }, now);
  const dashboard = await repo.dashboard(100, now);

  assert.equal(state.daySnapshotDeleted, true);
  assert.equal(state.storedDayBudget, 5714.29);
  assert.equal(dashboard.snapshot.reserve.amount, 5000);
  assert.equal(dashboard.snapshot.dayPlanLimit, 5714.29);
  assert.equal(dashboard.snapshot.dayRemaining, 5364.29);
});

test("monthly budget changes reject values that cannot fit planned obligations and active reserve", async () => {
  const now = new Date("2026-06-24T10:00:00+07:00");
  const state = createBudgetReserveState({
    monthlyBudget: 42000,
    plannedAmount: 2000,
    reserveAmount: 5000,
    storedDayBudget: 1200
  });
  const repo = createRepository(createBudgetReservePool(state));

  await assert.rejects(
    repo.updateMonthlyBudget(100, 6000, now),
    (error) => error.code === "reserve_conflicts_with_budget_change"
  );

  assert.equal(state.user.monthly_budget_amount, "42000");
  assert.equal(state.storedDayBudget, 1200);
  assert.equal(state.daySnapshotDeleted, false);
});

function createBudgetReserveState({
  monthlyBudget,
  plannedAmount,
  reserveAmount,
  regularToday = 0,
  plannedToday = 0,
  largeToday = 0,
  regularWeek = 0,
  plannedWeek = 0,
  largeWeek = 0,
  regularMonth = 0,
  plannedMonth = 0,
  largeMonth = 0,
  previousWeek = 0,
  storedDayBudget = null
}) {
  const user = {
    id: "1",
    telegram_user_id: "100",
    monthly_budget_amount: String(monthlyBudget),
    weekly_budget_amount: null,
    base_currency: "THB",
    display_currency: "USD",
    usd_thb_rate: "32.65",
    timezone: "Asia/Bangkok",
    budget_advice_enabled: true
  };
  return {
    user,
    planned: {
      id: "5",
      user_id: "1",
      amount: String(plannedAmount),
      currency: "THB",
      amount_base: String(plannedAmount),
      description: "therapy",
      category_slug: "health",
      tags: [],
      recurrence: "monthly",
      due_day: 30,
      due_days: [30],
      weekday: null,
      due_date: null,
      active: true,
      paid_count: 0,
      paid_occurrence_dates: [],
      paid_occurrences: {}
    },
    reserve: {
      id: "9",
      user_id: "1",
      period: "2026-06",
      timezone: "Asia/Bangkok",
      currency: "THB",
      budget_amount: String(monthlyBudget),
      reserve_amount: String(reserveAmount),
      title: "camera",
      status: "active"
    },
    paidPlannedAmount: 0,
    totals: {
      today: { regular: regularToday, planned: plannedToday, largeOneOff: largeToday },
      week: { regular: regularWeek, planned: plannedWeek, largeOneOff: largeWeek },
      month: { regular: regularMonth, planned: plannedMonth, largeOneOff: largeMonth },
      previousWeek: { regular: previousWeek, planned: 0, largeOneOff: 0 }
    },
    storedDayBudget,
    storedDayDisplayBudget: 0,
    daySnapshotDeleted: false,
    totalsCall: 0
  };
}

function createBudgetReservePool(state) {
  const query = async (sql, params = []) => handleBudgetReserveQuery(state, String(sql), params);
  return {
    query,
    async connect() {
      return {
        query,
        release() {}
      };
    }
  };
}

function handleBudgetReserveQuery(state, sql, params) {
  if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };

  if (sql.startsWith("SELECT * FROM users WHERE telegram_user_id")) return { rows: [state.user] };
  if (sql.startsWith("SELECT * FROM users WHERE id")) return { rows: [state.user] };

  if (sql.startsWith("UPDATE users") && sql.includes("monthly_budget_amount")) {
    state.user.monthly_budget_amount = String(params[0]);
    return { rows: [state.user] };
  }

  if (sql.startsWith("UPDATE planned_expenses")) {
    state.planned = {
      ...state.planned,
      amount: String(params[0]),
      currency: params[1],
      amount_base: String(params[2]),
      description: params[3],
      category_slug: params[4],
      tags: params[5],
      recurrence: params[6],
      due_day: params[7],
      due_days: params[8],
      weekday: params[9],
      due_date: params[10],
      active: params[11]
    };
    return { rows: [state.planned] };
  }

  if (sql.includes("SELECT planned_expenses.*, users.base_currency, users.usd_thb_rate")) {
    return { rows: [{ ...state.planned, base_currency: state.user.base_currency, usd_thb_rate: state.user.usd_thb_rate }] };
  }

  if (sql.includes("SELECT pep.occurrence_date::text")) {
    return {
      rows: state.planned.paid_occurrence_dates.map((date) => ({
        occurrence_date: date,
        paid_key: date
      }))
    };
  }

  if (sql.includes("INSERT INTO expenses") && sql.includes("budget_impact")) {
    state.paidPlannedAmount = Number(params[3]);
    return {
      rows: [{
        id: "77",
        user_id: params[0],
        amount_base: params[3],
        spent_at: params[11],
        budget_impact: params[12]
      }]
    };
  }

  if (sql.includes("INSERT INTO planned_expense_payments")) {
    state.planned = {
      ...state.planned,
      paid_occurrence_dates: [params[4]]
    };
    return { rows: [] };
  }

  if (sql.includes("INSERT INTO monthly_reserve_instances")) {
    state.reserve = {
      ...state.reserve,
      reserve_amount: String(params[5]),
      title: params[6],
      status: "active"
    };
    return { rows: [state.reserve] };
  }

  if (sql.includes("DELETE FROM daily_budget_snapshots")) {
    state.storedDayBudget = null;
    state.storedDayDisplayBudget = null;
    state.daySnapshotDeleted = true;
    return { rows: [] };
  }

  if (sql.includes("FROM monthly_reserve_instances") && sql.includes("period <")) return { rows: [] };
  if (sql.includes("FROM monthly_reserve_instances") && sql.includes("status = 'active'")) return { rows: [state.reserve] };
  if (sql.includes("FROM monthly_reserve_instances") && sql.includes("period = $2")) return { rows: [state.reserve] };
  if (sql.includes("FROM recurring_reserve_templates")) return { rows: [] };
  if (sql.includes("FROM closed_reserve_events")) return { rows: [] };

  if (sql.includes("monthly_budget_overrides")) return { rows: [] };
  if (sql.includes("month_baselines")) return { rows: [] };

  if (sql.includes("COUNT(planned_expense_payments.id)::int AS paid_count")) return { rows: [{ ...state.planned, paid_count: 0 }] };
  if (sql.includes("COALESCE(paid.paid_count")) return { rows: [{ ...state.planned, paid_count: 0 }] };
  if (sql.includes("FROM planned_expense_payments") && sql.includes("JOIN expenses")) return { rows: [{ total: state.paidPlannedAmount }] };

  if (sql.includes("FROM daily_budget_snapshots")) {
    return state.storedDayBudget == null
      ? { rows: [] }
      : { rows: [{ budget_amount_base: state.storedDayBudget, budget_display_amount: state.storedDayDisplayBudget ?? 0 }] };
  }

  if (sql.includes("INSERT INTO daily_budget_snapshots")) {
    state.storedDayBudget = Number(params[2]);
    state.storedDayDisplayBudget = Number(params[3]);
    return { rows: [{ budget_amount_base: params[2], budget_display_amount: params[3] }] };
  }

  if (sql.includes("COALESCE(SUM(amount_base)") && sql.includes("FILTER")) {
    state.totalsCall += 1;
    const total = state.totalsCall === 1
      ? state.totals.today
      : state.totalsCall === 2
        ? state.totals.week
        : state.totalsCall === 3
          ? state.totals.month
          : state.totals.previousWeek;
    return { rows: [periodTotalRow(total)] };
  }

  if (sql.includes("GROUP BY category_slug")) return { rows: [] };
  if (sql.includes("ORDER BY spent_at DESC")) return { rows: [] };
  if (sql.includes("ORDER BY amount_base DESC")) return { rows: [] };
  if (sql.includes("unnest(tags)")) return { rows: [] };
  if (sql.includes("EXTRACT(DAY")) return { rows: [] };

  return { rows: [] };
}

function periodTotalRow(total) {
  const regular = typeof total === "object" ? Number(total.regular ?? 0) : Number(total);
  const planned = typeof total === "object" ? Number(total.planned ?? 0) : 0;
  const largeOneOff = typeof total === "object" ? Number(total.largeOneOff ?? 0) : 0;
  const all = regular + planned + largeOneOff;
  const display = all / 32.65;
  return {
    total: all,
    regular_total: regular,
    planned_total: planned,
    large_oneoff_total: largeOneOff,
    display_total: display,
    regular_display_total: regular / 32.65,
    planned_display_total: planned / 32.65,
    large_oneoff_display_total: largeOneOff / 32.65
  };
}
