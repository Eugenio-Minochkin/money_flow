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

test("planned expense changes preserve today's snapshot while monthly state updates", async () => {
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
    active: false
  }, now);
  const dashboard = await repo.dashboard(100, now);

  assert.equal(state.daySnapshotDeleted, false);
  assert.equal(state.storedDayBudget, 999);
  assert.equal(dashboard.snapshot.plannedRemaining, 4000);
  assert.equal(dashboard.snapshot.dayPlanLimit, 999);
  assert.equal(dashboard.snapshot.dayRemaining, 649);
  assert.equal(dashboard.snapshot.freeRemaining, 40650);
  assert.equal(dashboard.snapshot.forecastMonthTotal, 4437.5);
  assert.equal(dashboard.snapshot.safeToSpendPerDay, 5807.14);
});

test("starts_on updates live planned values without rewriting today's snapshot", async () => {
  const now = new Date("2026-06-24T10:00:00+07:00");
  const state = createBudgetReserveState({
    monthlyBudget: 45000,
    plannedAmount: 1000,
    reserveAmount: 0,
    storedDayBudget: 999,
    storedDayKey: "2026-06-24"
  });
  state.planned.recurrence = "weekly";
  state.planned.weekday = 3;
  state.planned.starts_on = "2026-06-25";
  const repo = createRepository(createBudgetReservePool(state));

  const dashboard = await repo.dashboard(100, now);

  assert.equal(dashboard.snapshot.plannedRemaining, 0);
  assert.equal(dashboard.snapshot.plannedThisWeek, 0);
  assert.equal(dashboard.snapshot.dayPlanLimit, 999);
  assert.equal(state.daySnapshotDeleted, false);
});

test("creating a planned expense preserves today's existing snapshot", async () => {
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

  await repo.createPlannedExpense(100, {
    amount: 4000,
    currency: "THB",
    description: "rent",
    category_slug: "housing",
    recurrence: "monthly",
    due_day: 30
  }, now);
  const dashboard = await repo.dashboard(100, now);

  assert.equal(state.daySnapshotDeleted, false);
  assert.equal(dashboard.snapshot.dayPlanLimit, 999);
  assert.equal(dashboard.snapshot.plannedRemaining, 6000);
});

test("deactivating a planned expense preserves today's existing snapshot", async () => {
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

  const before = await repo.dashboard(100, now);
  state.totalsCall = 0;
  await repo.deactivatePlannedExpense(100, 5, now);
  const dashboard = await repo.dashboard(100, now);

  assert.equal(state.daySnapshotDeleted, false);
  assert.equal(dashboard.snapshot.dayPlanLimit, 999);
  assert.equal(dashboard.snapshot.plannedRemaining, 0);
  assert.equal(dashboard.snapshot.freeRemaining - before.snapshot.freeRemaining, 2000);
  assert.equal(before.snapshot.forecastMonthTotal - dashboard.snapshot.forecastMonthTotal, 2000);
});

test("first dashboard after a planned change creates a missing snapshot from current state", async () => {
  const now = new Date("2026-06-24T10:00:00+07:00");
  const state = createBudgetReserveState({
    monthlyBudget: 45000,
    plannedAmount: 2000,
    reserveAmount: 0,
    regularToday: 350,
    regularMonth: 350,
    storedDayBudget: null
  });
  const repo = createRepository(createBudgetReservePool(state));

  await repo.updatePlannedExpense(100, 5, {
    amount: 4000,
    currency: "THB",
    description: "therapy",
    category_slug: "health",
    recurrence: "monthly",
    due_day: 30
  }, now);
  const dashboard = await repo.dashboard(100, now);

  assert.equal(state.daySnapshotDeleted, false);
  assert.equal(dashboard.snapshot.dayPlanLimit, 5857.14);
  assert.equal(dashboard.snapshot.dayRemaining, 5507.14);
  assert.equal(dashboard.snapshot.plannedRemaining, 4000);
});

test("the next local day creates a new snapshot from the latest planned state", async () => {
  const firstDay = new Date("2026-06-24T10:00:00+07:00");
  const nextDay = new Date("2026-06-25T10:00:00+07:00");
  const state = createBudgetReserveState({
    monthlyBudget: 45000,
    plannedAmount: 2000,
    reserveAmount: 0,
    regularToday: 350,
    regularMonth: 350,
    storedDayBudget: 999,
    storedDayKey: "2026-06-24"
  });
  const repo = createRepository(createBudgetReservePool(state));

  await repo.updatePlannedExpense(100, 5, {
    amount: 4000,
    currency: "THB",
    description: "therapy",
    category_slug: "health",
    recurrence: "monthly",
    due_day: 30
  }, firstDay);
  const firstDashboard = await repo.dashboard(100, firstDay);
  state.totals.today = { regular: 0, planned: 0, largeOneOff: 0 };
  state.totalsCall = 0;
  const nextDashboard = await repo.dashboard(100, nextDay);

  assert.equal(firstDashboard.snapshot.dayPlanLimit, 999);
  assert.equal(state.daySnapshotDeleted, false);
  assert.equal(state.storedDayKey, "2026-06-25");
  assert.equal(nextDashboard.snapshot.dayPlanLimit, 6775);
  assert.equal(nextDashboard.snapshot.plannedRemaining, 4000);
});

test("paying a planned occurrence keeps the daily snapshot fixed without double subtraction", async () => {
  const now = new Date("2026-06-30T10:00:00+07:00");
  const state = createBudgetReserveState({
    monthlyBudget: 45000,
    plannedAmount: 2000,
    reserveAmount: 0,
    regularToday: 350,
    regularMonth: 350,
    storedDayBudget: 6142.86,
    storedDayKey: "2026-06-30"
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
      && error.details.nextBudgetAmount === 6000
      && error.details.plannedAmount === 2000
      && error.details.reserveAmount === 5000
      && error.details.minimumBudgetAmount === 7000
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
  storedDayBudget = null,
  storedDayKey = "2026-06-24"
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
  const planned = {
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
  };
  return {
    user,
    planned,
    plans: [planned],
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
    storedDayKey,
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

  if (sql.includes("UPDATE users u") && sql.includes("existing_user AS MATERIALIZED")) {
    const budgetChanged = Number(state.user.monthly_budget_amount) !== Number(params[0]);
    state.user.monthly_budget_amount = String(params[0]);
    return { rows: [{ ...state.user, budget_changed: budgetChanged }] };
  }

  if (sql.startsWith("UPDATE users") && sql.includes("monthly_budget_amount")) {
    state.user.monthly_budget_amount = String(params[0]);
    return { rows: [state.user] };
  }

  if (sql.startsWith("INSERT INTO planned_expenses")) {
    const created = {
      ...state.planned,
      id: String(state.plans.length + 5),
      amount: String(params[1]),
      currency: params[2],
      amount_base: String(params[3]),
      description: params[4],
      category_slug: params[5],
      tags: params[6],
      recurrence: params[7],
      due_day: params[8],
      due_days: params[9],
      weekday: params[10],
      due_date: params[11],
      paid_occurrence_dates: [],
      paid_occurrences: {},
      active: true
    };
    state.plans.push(created);
    return { rows: [created] };
  }

  if (sql.startsWith("UPDATE planned_expenses") && sql.includes("amount =")) {
    const targetId = String(params[11]);
    const target = state.plans.find((plan) => String(plan.id) === targetId) ?? state.planned;
    const updated = {
      ...target,
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
      due_date: params[10]
    };
    state.plans = state.plans.map((plan) => String(plan.id) === targetId ? updated : plan);
    if (String(state.planned.id) === targetId) state.planned = updated;
    return { rows: [updated] };
  }

  if (sql.startsWith("UPDATE planned_expenses") && sql.includes("active = false")) {
    const targetId = String(params[0]);
    const target = state.plans.find((plan) => String(plan.id) === targetId) ?? state.planned;
    const updated = { ...target, active: false };
    state.plans = state.plans.map((plan) => String(plan.id) === targetId ? updated : plan);
    if (String(state.planned.id) === targetId) state.planned = updated;
    return { rows: [updated] };
  }

  if (sql.includes("SELECT planned_expenses.*, users.base_currency, users.timezone") && sql.includes("FOR UPDATE")) {
    const target = state.plans.find((plan) => String(plan.id) === String(params[0])) ?? state.planned;
    if (!target || String(state.user.telegram_user_id) !== String(params[1])) return { rows: [] };
    return { rows: [{ ...target, base_currency: state.user.base_currency, timezone: state.user.timezone }] };
  }

  if (sql.includes("SELECT planned_expenses.*, users.base_currency, users.usd_thb_rate")) {
    const target = state.plans.find((plan) => String(plan.id) === String(params[0])) ?? state.planned;
    return { rows: [{ ...target, base_currency: state.user.base_currency, usd_thb_rate: state.user.usd_thb_rate }] };
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
    const updated = {
      ...state.planned,
      paid_occurrence_dates: [params[4]]
    };
    state.planned = updated;
    state.plans = state.plans.map((plan) => String(plan.id) === String(updated.id) ? updated : plan);
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
    state.storedDayKey = null;
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

  if (sql.startsWith("SELECT * FROM planned_expenses") && sql.includes("active = true")) {
    return { rows: state.plans.filter((plan) => plan.active) };
  }

  if (sql.includes("COUNT(expenses.id)::int AS paid_count")) {
    return { rows: state.plans.map((plan) => ({ ...plan, paid_count: 0 })) };
  }
  if (sql.includes("COALESCE(paid.paid_count")) {
    return { rows: state.plans.filter((plan) => plan.active).map((plan) => ({ ...plan, paid_count: 0 })) };
  }
  if (sql.includes("FROM planned_expense_payments") && sql.includes("JOIN expenses")) return { rows: [{ total: state.paidPlannedAmount }] };

  if (sql.includes("FROM daily_budget_snapshots")) {
    return state.storedDayBudget == null || state.storedDayKey !== params[1]
      ? { rows: [] }
      : { rows: [{ budget_amount_base: state.storedDayBudget, budget_display_amount: state.storedDayDisplayBudget ?? 0 }] };
  }

  if (sql.includes("INSERT INTO daily_budget_snapshots")) {
    state.storedDayBudget = Number(params[2]);
    state.storedDayDisplayBudget = Number(params[3]);
    state.storedDayKey = params[1];
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
