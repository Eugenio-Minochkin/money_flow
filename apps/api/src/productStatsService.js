import { localPeriodBounds } from "../../../packages/shared/src/time.js";
import { MEANINGFUL_ACTIVITY_EVENTS } from "./productAnalytics.js";

const DAY_MS = 24 * 60 * 60_000;

export function createProductStatsService({ pool, now = () => new Date() }) {
  return {
    async getProductStats() {
      const current = now();
      const cohortStart = new Date(current.getTime() - 30 * DAY_MS);
      const today = localPeriodBounds(current, "today");
      const periodParams = [
        today.start, current,
        new Date(current.getTime() - 3 * DAY_MS), current,
        new Date(current.getTime() - 7 * DAY_MS), current,
        cohortStart, current,
        [...MEANINGFUL_ACTIVITY_EVENTS]
      ];
      const meaningfulEvents = [...MEANINGFUL_ACTIVITY_EVENTS];

      const [userBaseResult, periodsResult, cohortResult, reportsResult, sourcesResult, healthResult] = await Promise.all([
        pool.query(USER_BASE_SQL),
        pool.query(PERIODS_SQL, periodParams),
        pool.query(COHORT_SQL, [cohortStart, current, meaningfulEvents]),
        pool.query(REPORTS_SQL, [cohortStart, current]),
        pool.query(SOURCES_SQL, [cohortStart]),
        pool.query(HEALTH_SQL, [new Date(current.getTime() - 7 * DAY_MS), current])
      ]);

      const userBase = mapUserBase(userBaseResult.rows[0]);
      const cohort = mapCohort(cohortResult.rows[0]);
      return {
        generatedAt: current,
        userBase,
        periods: mapPeriods(periodsResult.rows),
        funnel: cohort.funnel,
        activation: cohort.activation,
        retention: cohort.retention,
        habit: cohort.habit,
        reports: mapReports(reportsResult.rows[0]),
        sources: aggregateSources(sourcesResult.rows),
        health: mapHealth(healthResult.rows[0])
      };
    }
  };
}

const USER_BASE_SQL = `
/* product_user_base */
SELECT
  COUNT(*) FILTER (WHERE bot_blocked = false)::int AS reachable_now,
  COUNT(*) FILTER (WHERE bot_blocked = true)::int AS blocked_now,
  (SELECT COUNT(*)::int FROM app_events WHERE user_id IS NULL AND event_name = 'account_deleted') AS deleted_all_time
FROM users`;

const PERIODS_SQL = `
/* product_periods: report_delivered is intentionally excluded from meaningful activity */
WITH periods(label, start_at, end_at) AS (
  VALUES
    ('today', $1::timestamptz, $2::timestamptz),
    ('last3Days', $3::timestamptz, $4::timestamptz),
    ('last7Days', $5::timestamptz, $6::timestamptz),
    ('last30Days', $7::timestamptz, $8::timestamptz)
), meaningful_events AS (
  SELECT p.label, e.user_id, e.event_name, e.created_at
  FROM periods p
  JOIN app_events e ON e.created_at >= p.start_at AND e.created_at < p.end_at
  WHERE e.user_id IS NOT NULL AND e.event_name = ANY($9::text[])
), activity_days AS (
  SELECT label, user_id, COUNT(DISTINCT created_at::date)::int AS days
  FROM meaningful_events
  GROUP BY label, user_id
)
SELECT p.label,
  COUNT(DISTINCT m.user_id)::int AS active_users,
  (SELECT COUNT(*)::int FROM users u WHERE u.created_at >= p.start_at AND u.created_at < p.end_at) AS new_users,
  COUNT(*) FILTER (WHERE m.event_name = 'expense_saved')::int AS expenses_saved,
  COUNT(*) FILTER (WHERE m.event_name = 'expense_draft_created')::int AS drafts_created,
  COUNT(*) FILTER (WHERE m.event_name = 'expense_draft_confirmed')::int AS drafts_confirmed,
  COUNT(*) FILTER (WHERE m.event_name = 'feedback_sent')::int AS feedback_sent,
  (SELECT COUNT(*)::int FROM app_events e WHERE e.event_name = 'bot_blocked' AND e.created_at >= p.start_at AND e.created_at < p.end_at) AS newly_blocked,
  (SELECT COUNT(*)::int FROM app_events e WHERE e.event_name = 'bot_unblocked' AND e.created_at >= p.start_at AND e.created_at < p.end_at) AS newly_unblocked,
  (SELECT COUNT(*)::int FROM app_events e WHERE e.event_name = 'account_deleted' AND e.created_at >= p.start_at AND e.created_at < p.end_at) AS deleted_accounts,
  (SELECT COUNT(*)::int FROM activity_days d WHERE d.label = p.label AND d.days >= 2) AS active_two_days,
  (SELECT COUNT(*)::int FROM activity_days d WHERE d.label = p.label AND d.days >= 3) AS active_three_days
FROM periods p
LEFT JOIN meaningful_events m ON m.label = p.label
GROUP BY p.label, p.start_at, p.end_at`;

const COHORT_SQL = `
/* product_cohort */
WITH cohort AS (
  SELECT u.id AS user_id, u.timezone, s.first_started_at
  FROM users u
  CROSS JOIN LATERAL (
    SELECT MIN(e.created_at) AS first_started_at
    FROM app_events e
    WHERE e.user_id = u.id
      AND e.event_name IN ('bot_started', 'miniapp_opened')
      AND e.created_at >= u.created_at
  ) s
  WHERE u.created_at >= $1
    AND s.first_started_at IS NOT NULL
), cohort_metrics AS (
  SELECT c.*,
    EXISTS (SELECT 1 FROM app_events e WHERE e.user_id = c.user_id AND e.event_name = 'onboarding_started' AND e.created_at >= c.first_started_at) AS onboarding_started,
    EXISTS (SELECT 1 FROM app_events e WHERE e.user_id = c.user_id AND e.event_name = 'onboarding_completed' AND e.created_at >= c.first_started_at) AS onboarding_completed,
    EXISTS (SELECT 1 FROM app_events e WHERE e.user_id = c.user_id AND e.event_name = 'expense_draft_created' AND e.created_at >= c.first_started_at) AS first_draft_created,
    EXISTS (SELECT 1 FROM app_events e WHERE e.user_id = c.user_id AND e.event_name = 'dashboard_opened' AND e.created_at >= c.first_started_at) AS dashboard_opened,
    a.first_expense_at,
    EXISTS (
      SELECT 1 FROM app_events e
      WHERE e.user_id = c.user_id AND e.event_name = ANY($3::text[])
        AND e.created_at >= c.first_started_at + INTERVAL '24 hours'
        AND e.created_at < c.first_started_at + INTERVAL '48 hours'
    ) AS d1_returned,
    EXISTS (
      SELECT 1 FROM app_events e
      WHERE e.user_id = c.user_id AND e.event_name = ANY($3::text[])
        AND e.created_at >= c.first_started_at + INTERVAL '6 days'
        AND e.created_at < c.first_started_at + INTERVAL '8 days'
    ) AS d7_returned,
    (SELECT COUNT(DISTINCT (e.created_at AT TIME ZONE COALESCE(c.timezone, 'Asia/Bangkok'))::date)
     FROM app_events e
     WHERE e.user_id = c.user_id AND e.event_name = 'expense_saved'
       AND e.created_at >= c.first_started_at
       AND e.created_at < c.first_started_at + INTERVAL '7 days') >= 2 AS habit_started
  FROM cohort c
  LEFT JOIN LATERAL (
    SELECT MIN(e.created_at) AS first_expense_at
    FROM app_events e
    WHERE e.user_id = c.user_id AND e.event_name = 'expense_saved' AND e.created_at >= c.first_started_at
  ) a ON true
)
SELECT
  COUNT(*)::int AS started,
  COUNT(*) FILTER (WHERE onboarding_started)::int AS onboarding_started,
  COUNT(*) FILTER (WHERE onboarding_completed)::int AS onboarding_completed,
  COUNT(*) FILTER (WHERE first_draft_created)::int AS first_draft_created,
  COUNT(*) FILTER (WHERE first_expense_at IS NOT NULL)::int AS first_expense_saved,
  COUNT(*) FILTER (WHERE dashboard_opened)::int AS dashboard_opened,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_expense_at - first_started_at)))
    FILTER (WHERE first_expense_at IS NOT NULL) AS median_activation_seconds,
  COUNT(*) FILTER (WHERE $2 >= first_started_at + INTERVAL '48 hours')::int AS d1_eligible,
  COUNT(*) FILTER (WHERE $2 >= first_started_at + INTERVAL '48 hours' AND d1_returned)::int AS d1_returned,
  COUNT(*) FILTER (WHERE $2 >= first_started_at + INTERVAL '8 days')::int AS d7_eligible,
  COUNT(*) FILTER (WHERE $2 >= first_started_at + INTERVAL '8 days' AND d7_returned)::int AS d7_returned,
  COUNT(*) FILTER (WHERE $2 >= first_started_at + INTERVAL '7 days')::int AS habit_eligible,
  COUNT(*) FILTER (WHERE $2 >= first_started_at + INTERVAL '7 days' AND habit_started)::int AS habit_started
FROM cohort_metrics`;

const REPORTS_SQL = `
/* product_reports */
SELECT
  COUNT(DISTINCT user_id) FILTER (WHERE event_name = 'report_delivered')::int AS delivered_users,
  COUNT(DISTINCT user_id) FILTER (WHERE event_name = 'report_app_clicked')::int AS clicked_users,
  COUNT(*) FILTER (WHERE event_name = 'report_delivery_failed')::int AS failed_attempts
FROM app_events
WHERE created_at >= $1 AND created_at < $2`;

const SOURCES_SQL = `
/* product_sources */
WITH started AS (
  SELECT u.id AS user_id, COALESCE(u.acquisition_source, 'unknown') AS source,
    MIN(e.created_at) AS first_started_at
  FROM users u
  JOIN app_events e ON e.user_id = u.id
    AND e.event_name IN ('bot_started', 'miniapp_opened')
    AND e.created_at >= u.created_at
  WHERE u.created_at >= $1
  GROUP BY u.id, COALESCE(u.acquisition_source, 'unknown')
)
SELECT s.source, COUNT(*)::int AS started,
  COUNT(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM app_events e
    WHERE e.user_id = s.user_id AND e.event_name = 'expense_saved' AND e.created_at >= s.first_started_at
  ))::int AS activated
FROM started s
GROUP BY s.source
ORDER BY started DESC, activated DESC, s.source ASC`;

const HEALTH_SQL = `
/* product_health */
SELECT
  COUNT(*) FILTER (WHERE event_name = 'message_received')::int AS messages_total,
  COUNT(*) FILTER (WHERE event_name = 'expense_parse_failed')::int AS parse_failed,
  COUNT(*) FILTER (WHERE event_name = 'voice_transcription_failed')::int AS transcription_failed,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (metadata->>'processingTotalMs')::numeric)
    FILTER (WHERE event_name = 'message_processing_completed' AND metadata->>'inputType' = 'text' AND metadata->>'processingTotalMs' ~ '^[0-9]+(\\.[0-9]+)?$') AS p95_text_ms,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (metadata->>'processingTotalMs')::numeric)
    FILTER (WHERE event_name = 'message_processing_completed' AND metadata->>'inputType' = 'voice' AND metadata->>'processingTotalMs' ~ '^[0-9]+(\\.[0-9]+)?$') AS p95_voice_ms
FROM app_events
WHERE created_at >= $1 AND created_at < $2`;

function mapUserBase(row = {}) {
  const reachableNow = number(row.reachable_now);
  const blockedNow = number(row.blocked_now);
  const deletedAllTime = number(row.deleted_all_time);
  return { reachableNow, blockedNow, deletedAllTime, allTimeJoined: reachableNow + blockedNow + deletedAllTime };
}

function mapPeriods(rows) {
  return Object.fromEntries(rows.map((row) => {
    const activeUsers = number(row.active_users);
    const expensesSaved = number(row.expenses_saved);
    const draftsCreated = number(row.drafts_created);
    const draftsConfirmed = number(row.drafts_confirmed);
    return [row.label, {
      activeUsers, newUsers: number(row.new_users), expensesSaved,
      expensesPerActiveUser: ratio(expensesSaved, activeUsers), draftsCreated, draftsConfirmed,
      confirmRate: ratio(draftsConfirmed, draftsCreated), feedbackSent: number(row.feedback_sent),
      newlyBlocked: number(row.newly_blocked), newlyUnblocked: number(row.newly_unblocked),
      deletedAccounts: number(row.deleted_accounts), activeTwoDays: number(row.active_two_days),
      activeThreeDays: number(row.active_three_days)
    }];
  }));
}

function mapCohort(row = {}) {
  const started = number(row.started);
  const funnel = {
    started,
    onboardingStarted: number(row.onboarding_started), onboardingCompleted: number(row.onboarding_completed),
    firstDraftCreated: number(row.first_draft_created), firstExpenseSaved: number(row.first_expense_saved),
    dashboardOpened: number(row.dashboard_opened)
  };
  return {
    funnel,
    activation: { medianHours: row.median_activation_seconds == null ? null : Number(row.median_activation_seconds) / 3600 },
    retention: {
      d1Eligible: number(row.d1_eligible), d1Returned: number(row.d1_returned),
      d1Rate: ratio(number(row.d1_returned), number(row.d1_eligible)),
      d7Eligible: number(row.d7_eligible), d7Returned: number(row.d7_returned),
      d7Rate: ratio(number(row.d7_returned), number(row.d7_eligible))
    },
    habit: {
      eligible: number(row.habit_eligible), started: number(row.habit_started),
      rate: ratio(number(row.habit_started), number(row.habit_eligible))
    }
  };
}

function mapReports(row = {}) {
  const deliveredUsers = number(row.delivered_users);
  const clickedUsers = number(row.clicked_users);
  return { deliveredUsers, clickedUsers, failedAttempts: number(row.failed_attempts), ctr: ratio(clickedUsers, deliveredUsers) };
}

function aggregateSources(rows) {
  const mapped = rows.map((row) => ({
    source: row.source || "unknown", started: number(row.started), activated: number(row.activated),
    activationRate: ratio(number(row.activated), number(row.started))
  })).sort((a, b) => b.started - a.started || b.activated - a.activated || a.source.localeCompare(b.source));
  if (mapped.length <= 5) return mapped;
  const rest = mapped.slice(5).reduce((sum, row) => ({ started: sum.started + row.started, activated: sum.activated + row.activated }), { started: 0, activated: 0 });
  return [...mapped.slice(0, 5), { source: "other", ...rest, activationRate: ratio(rest.activated, rest.started) }];
}

function mapHealth(row = {}) {
  const messagesTotal = number(row.messages_total);
  return {
    parseFailed: number(row.parse_failed), parseFailedRate: ratio(number(row.parse_failed), messagesTotal),
    transcriptionFailed: number(row.transcription_failed),
    p95TextSeconds: row.p95_text_ms == null ? null : Number(row.p95_text_ms) / 1000,
    p95VoiceSeconds: row.p95_voice_ms == null ? null : Number(row.p95_voice_ms) / 1000
  };
}

function number(value) { return Number(value ?? 0); }
function ratio(numerator, denominator) { return denominator > 0 ? numerator / denominator : null; }
