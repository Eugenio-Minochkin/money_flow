const BANGKOK_OFFSET_MS = 7 * 60 * 60_000;

export function createAdminStatsService({ pool, now = () => new Date() }) {
  return {
    async getAdminStats() {
      const current = now();
      const usersCreatedAtAvailable = await hasUsersCreatedAt(pool);
      const periods = {
        today: { start: startOfBangkokDay(current), end: current },
        last7Days: { start: new Date(current.getTime() - 7 * 24 * 60 * 60_000), end: current },
        last30Days: { start: new Date(current.getTime() - 30 * 24 * 60 * 60_000), end: current }
      };

      return {
        today: await periodStats(pool, periods.today, usersCreatedAtAvailable),
        last7Days: await periodStats(pool, periods.last7Days, usersCreatedAtAvailable),
        last30Days: await periodStats(pool, periods.last30Days, usersCreatedAtAvailable)
      };
    }
  };
}

export function formatAdminStats(stats) {
  return [
    "Admin stats",
    "",
    formatPeriod("Today", stats.today, { includeRates: false }),
    "",
    formatPeriod("Last 7 days", stats.last7Days, { includeRates: true }),
    "",
    formatPeriod("Last 30 days", stats.last30Days, { includeRates: true })
  ].join("\n");
}

async function periodStats(pool, period, usersCreatedAtAvailable) {
  const [events, historical, newUsers] = await Promise.all([
    aggregateEvents(pool, period),
    aggregateHistoricalActivity(pool, period),
    countNewUsers(pool, period, usersCreatedAtAvailable)
  ]);
  const textMessages = fallbackCount(events.textDirect, events.textFromMessage);
  const voiceMessages = fallbackCount(events.voiceDirect, events.voiceFromMessage);
  const photoMessages = fallbackCount(events.photoDirect, events.photoFromMessage);
  const messagesTotal = Number(events.messageReceived) > 0
    ? Number(events.messageReceived)
    : textMessages + voiceMessages + photoMessages;
  const expensesSaved = fallbackCount(events.expensesSaved, historical.expensesSaved);
  const draftsCreated = fallbackCount(events.draftsCreated, historical.draftsCreated);
  const draftsConfirmed = fallbackCount(events.draftsConfirmed, historical.draftsConfirmed);
  const draftsCancelled = fallbackCount(events.draftsCancelled, historical.draftsCancelled);
  const parseFailed = Number(events.parseFailed);

  return {
    activeUsers: Number(events.activeUsers),
    newUsers,
    messagesTotal,
    textMessages,
    voiceMessages,
    photoMessages,
    expensesSaved,
    draftsCreated,
    draftsConfirmed,
    draftsCancelled,
    parseFailed,
    transcriptionFailed: Number(events.transcriptionFailed),
    avgTextProcessingSeconds: secondsOrNull(events.avgTextProcessingMs),
    avgVoiceProcessingSeconds: secondsOrNull(events.avgVoiceProcessingMs),
    confirmRate: draftsCreated > 0 ? Math.round((draftsConfirmed / draftsCreated) * 100) : null,
    parseFailedRate: messagesTotal > 0 ? Math.round((parseFailed / messagesTotal) * 100) : null
  };
}

async function aggregateHistoricalActivity(pool, period) {
  const result = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int
        FROM expenses
        WHERE created_at >= $1 AND created_at < $2) AS expenses_saved,
       ((SELECT COUNT(*)::int
         FROM drafts
         WHERE created_at >= $1 AND created_at < $2)
        +
        (SELECT COUNT(*)::int
         FROM planned_drafts
         WHERE created_at >= $1 AND created_at < $2)) AS drafts_created,
       ((SELECT COUNT(*)::int
         FROM drafts
         WHERE confirmed_at >= $1 AND confirmed_at < $2)
        +
        (SELECT COUNT(*)::int
         FROM planned_drafts
         WHERE confirmed_at >= $1 AND confirmed_at < $2)) AS drafts_confirmed,
       ((SELECT COUNT(*)::int
         FROM drafts
         WHERE status = 'cancelled'
           AND created_at >= $1 AND created_at < $2)
        +
        (SELECT COUNT(*)::int
         FROM planned_drafts
         WHERE status = 'cancelled'
           AND created_at >= $1 AND created_at < $2)) AS drafts_cancelled`,
    [period.start, period.end]
  );

  const row = result.rows[0] ?? {};
  return {
    expensesSaved: numeric(row.expenses_saved),
    draftsCreated: numeric(row.drafts_created),
    draftsConfirmed: numeric(row.drafts_confirmed),
    draftsCancelled: numeric(row.drafts_cancelled)
  };
}

async function aggregateEvents(pool, period) {
  const result = await pool.query(
    `SELECT
       COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL)::int AS active_users,
       COUNT(*) FILTER (WHERE event_name = 'message_received')::int AS message_received,
       COUNT(*) FILTER (WHERE event_name = 'text_message_received')::int AS text_direct,
       COUNT(*) FILTER (WHERE event_name = 'message_received' AND metadata->>'inputType' = 'text')::int AS text_from_message,
       COUNT(*) FILTER (WHERE event_name = 'voice_message_received')::int AS voice_direct,
       COUNT(*) FILTER (WHERE event_name = 'message_received' AND metadata->>'inputType' = 'voice')::int AS voice_from_message,
       COUNT(*) FILTER (WHERE event_name = 'photo_message_received')::int AS photo_direct,
       COUNT(*) FILTER (WHERE event_name = 'message_received' AND metadata->>'inputType' = 'photo')::int AS photo_from_message,
       COUNT(*) FILTER (WHERE event_name = 'expense_saved')::int AS expenses_saved,
       COUNT(*) FILTER (WHERE event_name = 'expense_draft_created')::int AS drafts_created,
       COUNT(*) FILTER (WHERE event_name = 'expense_draft_confirmed')::int AS drafts_confirmed,
       COUNT(*) FILTER (WHERE event_name = 'expense_draft_cancelled')::int AS drafts_cancelled,
       COUNT(*) FILTER (WHERE event_name = 'expense_parse_failed')::int AS parse_failed,
       COUNT(*) FILTER (WHERE event_name = 'voice_transcription_failed')::int AS transcription_failed,
       AVG(CASE
         WHEN metadata->>'processingTotalMs' ~ '^[0-9]+(\\.[0-9]+)?$'
         THEN (metadata->>'processingTotalMs')::numeric
       END) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'inputType' = 'text'
       )::float AS avg_text_processing_ms,
       AVG(CASE
         WHEN metadata->>'processingTotalMs' ~ '^[0-9]+(\\.[0-9]+)?$'
         THEN (metadata->>'processingTotalMs')::numeric
       END) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'inputType' = 'voice'
       )::float AS avg_voice_processing_ms
     FROM app_events
     WHERE created_at >= $1 AND created_at < $2`,
    [period.start, period.end]
  );

  const row = result.rows[0] ?? {};
  return {
    activeUsers: numeric(row.active_users),
    messageReceived: numeric(row.message_received),
    textDirect: numeric(row.text_direct),
    textFromMessage: numeric(row.text_from_message),
    voiceDirect: numeric(row.voice_direct),
    voiceFromMessage: numeric(row.voice_from_message),
    photoDirect: numeric(row.photo_direct),
    photoFromMessage: numeric(row.photo_from_message),
    expensesSaved: numeric(row.expenses_saved),
    draftsCreated: numeric(row.drafts_created),
    draftsConfirmed: numeric(row.drafts_confirmed),
    draftsCancelled: numeric(row.drafts_cancelled),
    parseFailed: numeric(row.parse_failed),
    transcriptionFailed: numeric(row.transcription_failed),
    avgTextProcessingMs: nullableNumeric(row.avg_text_processing_ms),
    avgVoiceProcessingMs: nullableNumeric(row.avg_voice_processing_ms)
  };
}

async function countNewUsers(pool, period, usersCreatedAtAvailable) {
  if (usersCreatedAtAvailable) {
    const result = await pool.query(
      "SELECT COUNT(*)::int AS new_users FROM users WHERE created_at >= $1 AND created_at < $2",
      [period.start, period.end]
    );
    return numeric(result.rows[0]?.new_users);
  }

  const result = await pool.query(
    `SELECT COUNT(*)::int AS new_users
     FROM (
       SELECT user_id, MIN(created_at) AS first_event_at
       FROM app_events
       WHERE user_id IS NOT NULL
       GROUP BY user_id
     ) first_events
     WHERE first_event_at >= $1 AND first_event_at < $2`,
    [period.start, period.end]
  );
  return numeric(result.rows[0]?.new_users);
}

async function hasUsersCreatedAt(pool) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'users'
         AND column_name = 'created_at'
     ) AS exists`
  );
  return Boolean(result.rows[0]?.exists);
}

function formatPeriod(label, period, options) {
  return [
    `${label}:`,
    `Users: ${period.activeUsers} active / ${period.newUsers} new`,
    `Messages: ${period.messagesTotal} total / ${period.textMessages} text / ${period.voiceMessages} voice / ${period.photoMessages} photo`,
    `Expenses saved: ${period.expensesSaved}`,
    `Drafts: ${period.draftsCreated} created / ${period.draftsConfirmed} confirmed / ${period.draftsCancelled} cancelled`,
    `Errors: ${period.parseFailed} parse / ${period.transcriptionFailed} transcription`,
    ...(options.includeRates ? [
      `Confirm rate: ${formatPercent(period.confirmRate)}`,
      `Parse failed rate: ${formatPercent(period.parseFailedRate)}`
    ] : []),
    `Avg processing: text ${formatSeconds(period.avgTextProcessingSeconds)} / voice ${formatSeconds(period.avgVoiceProcessingSeconds)}`
  ].join("\n");
}

function fallbackCount(primary, fallback) {
  return Number(primary) > 0 ? Number(primary) : Number(fallback);
}

function secondsOrNull(value) {
  const number = nullableNumeric(value);
  return number == null ? null : Math.round((number / 1000) * 10) / 10;
}

function formatSeconds(value) {
  return value == null ? "-" : `${Number(value).toFixed(1)}s`;
}

function formatPercent(value) {
  return value == null ? "-" : `${Math.round(Number(value))}%`;
}

function numeric(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function nullableNumeric(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function startOfBangkokDay(now) {
  const local = new Date(now.getTime() + BANGKOK_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - BANGKOK_OFFSET_MS);
}
