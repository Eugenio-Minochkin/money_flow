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
  assert.equal(state.storedDayBudget, 4428.57);
  assert.equal(dashboard.snapshot.monthlyBudget, 48000);
  assert.equal(dashboard.snapshot.plannedRemaining, 2000);
  assert.equal(dashboard.snapshot.reserve.amount, 5000);
  assert.equal(dashboard.snapshot.reserve.savedAmount, 5000);
  assert.equal(dashboard.snapshot.reserve.eatenAmount, 0);
  assert.equal(dashboard.snapshot.freeRemaining, 31000);
  assert.equal(dashboard.snapshot.safeToSpendPerDay, 4428.57);
  assert.equal(dashboard.snapshot.dayPlanLimit, 4428.57);
  assert.equal(dashboard.snapshot.dayRemaining, 4328.57);
  assert.equal(dashboard.snapshot.forecastMonthTotal, 14500);
  assert.equal(dashboard.snapshot.averageDailyRegularSpending, 416.67);
  assert.equal(dashboard.snapshot.reserve.forecast.forecastRegularSpentAmount, 12500);
  assert.equal(dashboard.snapshot.reserve.forecast.savedAmount, 5000);
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
  regularWeek = 0,
  regularMonth = 0,
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
    totals: {
      today: regularToday,
      week: regularWeek,
      month: regularMonth,
      previousWeek
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
  if (sql.includes("FROM planned_expense_payments") && sql.includes("JOIN expenses")) return { rows: [{ total: 0 }] };

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
  const display = total / 32.65;
  return {
    total,
    regular_total: total,
    planned_total: 0,
    large_oneoff_total: 0,
    display_total: display,
    regular_display_total: display,
    planned_display_total: 0,
    large_oneoff_display_total: 0
  };
}
