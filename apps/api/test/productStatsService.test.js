import test from "node:test";
import assert from "node:assert/strict";

import { createProductStatsService } from "../src/productStatsService.js";
import { MEANINGFUL_ACTIVITY_EVENTS } from "../src/productAnalytics.js";

test("product stats use grouped periods and privacy-preserving user base", async () => {
  const queries = [];
  const service = createProductStatsService({
    pool: fixturePool(queries),
    now: () => new Date("2026-07-10T10:00:00Z")
  });

  const stats = await service.getProductStats();

  assert.deepEqual(stats.userBase, { reachableNow: 8, blockedNow: 2, deletedAllTime: 3, allTimeJoined: 13 });
  assert.equal(stats.periods.today.activeUsers, 2);
  assert.equal(stats.periods.last7Days.activeTwoDays, 4);
  assert.equal(stats.periods.last30Days.activeThreeDays, 5);
  const periodsQuery = queries.find((query) => query.sql.includes("product_periods"));
  assert.equal(periodsQuery.params.length, 9);
  assert.deepEqual(periodsQuery.params[8], [...MEANINGFUL_ACTIVITY_EVENTS]);
  assert.match(periodsQuery.sql, /report_delivered/);
  assert.match(periodsQuery.sql, /NOT.*report_delivered|meaningful_events/s);
});

test("product cohort SQL anchors users.created_at and uses mature retention windows", async () => {
  const queries = [];
  const stats = await createProductStatsService({
    pool: fixturePool(queries),
    now: () => new Date("2026-07-10T10:00:00Z")
  }).getProductStats();

  const cohort = queries.find((query) => query.sql.includes("product_cohort"));
  assert.match(cohort.sql, /u\.created_at >= \$1/);
  assert.match(cohort.sql, /e\.created_at >= u\.created_at/);
  assert.match(cohort.sql, /PERCENTILE_CONT\(0\.5\)/);
  assert.match(cohort.sql, /INTERVAL '24 hours'/);
  assert.match(cohort.sql, /INTERVAL '48 hours'/);
  assert.match(cohort.sql, /INTERVAL '6 days'/);
  assert.match(cohort.sql, /INTERVAL '8 days'/);
  assert.match(cohort.sql, /AT TIME ZONE/);
  assert.equal(stats.funnel.firstExpenseSaved, 4);
  assert.equal(stats.retention.d1Rate, 0.5);
  assert.equal(stats.retention.d7Rate, null);
  assert.equal(stats.habit.rate, 0.5);
});

test("report CTR and sources are mapped without click inflation", async () => {
  const stats = await createProductStatsService({
    pool: fixturePool([]),
    now: () => new Date("2026-07-10T10:00:00Z")
  }).getProductStats();

  assert.deepEqual(stats.reports, { deliveredUsers: 10, clickedUsers: 3, failedAttempts: 4, ctr: 0.3 });
  assert.deepEqual(stats.sources, [
    { source: "direct", started: 5, activated: 3, activationRate: 0.6 },
    { source: "unknown", started: 2, activated: 0, activationRate: 0 }
  ]);
});

function fixturePool(queries) {
  return {
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (text.includes("product_user_base")) return { rows: [{ reachable_now: 8, blocked_now: 2, deleted_all_time: 3 }] };
      if (text.includes("product_periods")) return { rows: [
        period("today", { active_users: 2 }),
        period("last3Days"),
        period("last7Days", { active_two_days: 4 }),
        period("last30Days", { active_three_days: 5 })
      ] };
      if (text.includes("product_cohort")) return { rows: [{
        started: 6, onboarding_started: 5, onboarding_completed: 4, first_draft_created: 4,
        first_expense_saved: 4, dashboard_opened: 3, median_activation_seconds: 7200,
        d1_eligible: 4, d1_returned: 2, d7_eligible: 0, d7_returned: 0,
        habit_eligible: 4, habit_started: 2
      }] };
      if (text.includes("product_reports")) return { rows: [{ delivered_users: 10, clicked_users: 3, failed_attempts: 4 }] };
      if (text.includes("product_sources")) return { rows: [
        { source: "direct", started: 5, activated: 3 },
        { source: "unknown", started: 2, activated: 0 }
      ] };
      if (text.includes("product_health")) return { rows: [{}] };
      throw new Error(`Unexpected query: ${text.slice(0, 80)}`);
    }
  };
}

function period(label, overrides = {}) {
  return {
    label, active_users: 0, new_users: 0, expenses_saved: 0, drafts_created: 0,
    drafts_confirmed: 0, feedback_sent: 0, newly_blocked: 0, newly_unblocked: 0,
    deleted_accounts: 0, active_two_days: 0, active_three_days: 0, ...overrides
  };
}
