import { localPeriodBounds } from "../../../packages/shared/src/time.js";

export function createTechnicalStatsService({ pool, now = () => new Date() }) {
  return {
    async getTechnicalStats() {
      const current = now();
      const usersCreatedAtAvailable = await hasUsersCreatedAt(pool);
      const periods = {
        today: { start: localPeriodBounds(current, "today").start, end: current },
        last7Days: { start: new Date(current.getTime() - 7 * 24 * 60 * 60_000), end: current }
      };

      return {
        generatedAt: current,
        today: await periodStats(pool, periods.today, usersCreatedAtAvailable),
        last7Days: await periodStats(pool, periods.last7Days, usersCreatedAtAvailable)
      };
    }
  };
}

export function formatTechnicalStats(stats) {
  return [
    "Admin stats",
    "",
    formatPeriod("Today", stats.today, { includeRates: false, includeConfirmFlow: true }),
    "",
    formatPeriod("Last 7 days", stats.last7Days, { includeRates: true, includeConfirmFlow: true })
  ].join("\n");
}

export function formatTechnicalStatsSections(stats) {
  const sections = [{ heading: "🛠 Technical stats", rows: [generatedRow(stats.generatedAt)] }];
  for (const [label, period] of [["Today", stats.today], ["Last 7 days", stats.last7Days]]) {
    const lines = formatPeriod(label, period, { includeRates: label !== "Today", includeConfirmFlow: true }).split("\n").slice(1);
    const groups = [
      ["Traffic", /^(Users|Messages|Expenses saved|Drafts):/],
      ["Errors", /^(Errors|Confirm rate|Parse failed rate):/],
      ["Confirm flow", /^Confirm (flow|outcomes|avg|P95):/],
      ["Processing", /^(Avg processing|P95 processing):/],
      ["Processing stages", /^(Avg stages|P95 stages):/],
      ["Parser routing and averages", /^(Parser:|Parser routing:|Parser avg:|Local acceptance:|Levels:|LLM fallback:|Internal latency)/],
      ["Review", /^Review:/],
      ["Shadow", /^(Shadow:|Critical shadow:|Category-only shadow:|Amount\/currency shadow:)/],
      ["Rejects", /^Rejects:/],
      ["Shadow fields", /^Shadow fields:/]
    ];
    for (const [name, pattern] of groups) {
      const rows = lines.filter((line) => pattern.test(line));
      if (rows.length > 0) sections.push({ heading: `${technicalSectionEmoji(name)} ${label} — ${name}`, rows: rows.map(highlightTechnicalRow) });
    }
  }
  return sections;
}

function highlightTechnicalRow(line) {
  if (line.startsWith("Rejects:") || line.startsWith("Shadow fields:")) {
    const [label, ...value] = line.split(":");
    return richRow([plain(`${label}: `), code(value.join(":").trim())]);
  }
  const users = line.match(/^Users: (.+? active)(.*)$/);
  if (users) return richRow([plain("Users: "), bold(users[1]), plain(users[2])]);
  const separator = line.indexOf(":");
  if (separator < 0) return line;
  return richRow([plain(line.slice(0, separator + 2)), bold(line.slice(separator + 2))]);
}

function technicalSectionEmoji(name) {
  if (name === "Confirm flow") return "✅";
  return ({ Traffic: "📨", Errors: "⚠️", Processing: "⏱", "Processing stages": "🧭", "Parser routing and averages": "🧠", Review: "🔎", Shadow: "👤", Rejects: "🚫", "Shadow fields": "🧩" })[name] ?? "•";
}

function generatedRow(value) {
  return richRow([plain("Generated: "), code(formatGeneratedAt(value))]);
}

function formatGeneratedAt(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function richRow(segments) { return { segments }; }
function plain(text) { return { text, style: "plain" }; }
function bold(text) { return { text, style: "bold" }; }
function code(text) { return { text, style: "code" }; }

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
    confirmFlow: {
      attempts: Number(events.confirmAttempts),
      success: Number(events.confirmSuccessCount),
      alreadySaved: Number(events.confirmAlreadySavedCount),
      cancelled: Number(events.confirmCancelledCount),
      categoryRequired: Number(events.confirmCategoryRequiredCount),
      failed: Number(events.confirmFailedCount),
      avgCallbackAckSeconds: secondsOrNull(events.avgConfirmCallbackAckMs),
      p95CallbackAckSeconds: secondsOrNull(events.p95ConfirmCallbackAckMs),
      avgUserResultSeconds: secondsOrNull(events.avgConfirmUserResultMs),
      p95UserResultSeconds: secondsOrNull(events.p95ConfirmUserResultMs),
      avgTotalSeconds: secondsOrNull(events.avgConfirmTotalMs),
      p95TotalSeconds: secondsOrNull(events.p95ConfirmTotalMs),
      avgDbSaveSeconds: secondsOrNull(events.avgConfirmDbSaveMs),
      p95DbSaveSeconds: secondsOrNull(events.p95ConfirmDbSaveMs),
      avgTelegramUpdateSeconds: secondsOrNull(events.avgConfirmTelegramUpdateMs),
      p95TelegramUpdateSeconds: secondsOrNull(events.p95ConfirmTelegramUpdateMs)
    },
    avgTextProcessingSeconds: secondsOrNull(events.avgTextProcessingMs),
    avgVoiceProcessingSeconds: secondsOrNull(events.avgVoiceProcessingMs),
    p95TextProcessingSeconds: secondsOrNull(events.p95TextProcessingMs),
    p95VoiceProcessingSeconds: secondsOrNull(events.p95VoiceProcessingMs),
    avgTextStageSeconds: {
      queue: secondsOrNull(events.avgTextQueueWaitMs),
      telegramResponse: secondsOrNull(events.avgTextTelegramResponseMs),
      llmParse: secondsOrNull(events.avgTextLlmParseMs),
      dbSave: secondsOrNull(events.avgTextDbSaveMs)
    },
    avgVoiceStageSeconds: {
      queue: secondsOrNull(events.avgVoiceQueueWaitMs),
      telegramFileDownload: secondsOrNull(events.avgVoiceTelegramFileDownloadMs),
      transcription: secondsOrNull(events.avgVoiceTranscriptionMs),
      llmParse: secondsOrNull(events.avgVoiceLlmParseMs),
      telegramResponse: secondsOrNull(events.avgVoiceTelegramResponseMs),
      dbSave: secondsOrNull(events.avgVoiceDbSaveMs)
    },
    p95TextStageSeconds: {
      llmParse: secondsOrNull(events.p95TextLlmParseMs),
      dbSave: secondsOrNull(events.p95TextDbSaveMs)
    },
    p95VoiceStageSeconds: {
      telegramFileDownload: secondsOrNull(events.p95VoiceTelegramFileDownloadMs),
      transcription: secondsOrNull(events.p95VoiceTranscriptionMs),
      llmParse: secondsOrNull(events.p95VoiceLlmParseMs),
      dbSave: secondsOrNull(events.p95VoiceDbSaveMs)
    },
    localFastPathCount: Number(events.localFastPathCount),
    localCandidateCount: Number(events.localCandidateCount),
    localAcceptedCount: Number(events.localAcceptedCount),
    localPrimaryCount: Number(events.localPrimaryCount),
    localSafeCount: Number(events.localSafeCount),
    localReviewableCount: Number(events.localReviewableCount),
    localReviewableLlmCount: Number(events.localReviewableLlmCount),
    localReviewableFallbackCount: Number(events.localReviewableFallbackCount),
    localRejectedCount: Number(events.localRejectedCount),
    localRejectedFallbackCount: Number(events.localRejectedFallbackCount),
    localExceptionFallbackCount: Number(events.localExceptionFallbackCount),
    rolloutExcludedCount: Number(events.rolloutExcludedCount),
    nonExpenseGuardCount: Number(events.nonExpenseGuardCount),
    llmCount: Number(events.llmCount),
    llmPrimaryCount: Number(events.llmPrimaryCount),
    llmSkippedCount: Number(events.llmSkippedCount),
    llmFallbackCount: Number(events.llmFallbackCount),
    categoryNeedsReviewCount: Number(events.categoryNeedsReviewCount),
    shadowDisagreementCount: Number(events.shadowDisagreementCount),
    shadowComparedCount: Number(events.shadowComparedCount),
    criticalShadowDisagreementCount: Number(events.criticalShadowDisagreementCount),
    categoryOnlyShadowDisagreementCount: Number(events.categoryOnlyShadowDisagreementCount),
    amountShadowDisagreementCount: Number(events.amountShadowDisagreementCount),
    currencyShadowDisagreementCount: Number(events.currencyShadowDisagreementCount),
    criticalShadowDisagreementRate: disagreementRate(events.criticalShadowDisagreementCount, events.shadowComparedCount),
    categoryOnlyShadowDisagreementRate: disagreementRate(events.categoryOnlyShadowDisagreementCount, events.shadowComparedCount),
    amountShadowDisagreementRate: disagreementRate(events.amountShadowDisagreementCount, events.shadowComparedCount),
    currencyShadowDisagreementRate: disagreementRate(events.currencyShadowDisagreementCount, events.shadowComparedCount),
    avgLocalParseSeconds: millisecondsToSeconds(events.avgLocalParseMs),
    p95LocalParseSeconds: millisecondsToSeconds(events.p95LocalParseMs),
    avgLlmHttpSeconds: millisecondsToSeconds(events.avgLlmHttpMs),
    p95LlmHttpSeconds: millisecondsToSeconds(events.p95LlmHttpMs),
    avgLocalFastPathProcessingSeconds: secondsOrNull(events.avgLocalFastPathProcessingMs),
    avgLlmProcessingSeconds: secondsOrNull(events.avgLlmProcessingMs),
    localFastPathRejectReasons: objectFromJson(events.localFastPathRejectReasons),
    shadowDisagreementFields: objectFromJson(events.shadowDisagreementFields),
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
       COUNT(*) FILTER (
         WHERE event_name = 'draft_confirm_processing_completed'
           AND metadata->>'outcome' IN ('success', 'already_saved', 'cancelled', 'category_required', 'failed')
       )::int AS confirm_attempts,
       COUNT(*) FILTER (
         WHERE event_name = 'draft_confirm_processing_completed' AND metadata->>'outcome' = 'success'
       )::int AS confirm_success_count,
       COUNT(*) FILTER (
         WHERE event_name = 'draft_confirm_processing_completed' AND metadata->>'outcome' = 'already_saved'
       )::int AS confirm_already_saved_count,
       COUNT(*) FILTER (
         WHERE event_name = 'draft_confirm_processing_completed' AND metadata->>'outcome' = 'cancelled'
       )::int AS confirm_cancelled_count,
       COUNT(*) FILTER (
         WHERE event_name = 'draft_confirm_processing_completed' AND metadata->>'outcome' = 'category_required'
       )::int AS confirm_category_required_count,
       COUNT(*) FILTER (
         WHERE event_name = 'draft_confirm_processing_completed' AND metadata->>'outcome' = 'failed'
       )::int AS confirm_failed_count,
       AVG(CASE WHEN metadata->>'callbackAckMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'callbackAckMs')::numeric END) FILTER (
         WHERE event_name = 'draft_confirm_processing_completed'
       )::float AS avg_confirm_callback_ack_ms,
       PERCENTILE_CONT(0.95) WITHIN GROUP (
         ORDER BY CASE WHEN metadata->>'callbackAckMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'callbackAckMs')::numeric END
       ) FILTER (
         WHERE event_name = 'draft_confirm_processing_completed'
           AND metadata->>'callbackAckMs' ~ '^[0-9]+(\\.[0-9]+)?$'
       )::float AS p95_confirm_callback_ack_ms,
       AVG(CASE WHEN metadata->>'userResultMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'userResultMs')::numeric END) FILTER (
         WHERE event_name = 'draft_confirm_processing_completed'
       )::float AS avg_confirm_user_result_ms,
       PERCENTILE_CONT(0.95) WITHIN GROUP (
         ORDER BY CASE WHEN metadata->>'userResultMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'userResultMs')::numeric END
       ) FILTER (
         WHERE event_name = 'draft_confirm_processing_completed'
           AND metadata->>'userResultMs' ~ '^[0-9]+(\\.[0-9]+)?$'
       )::float AS p95_confirm_user_result_ms,
       AVG(CASE WHEN metadata->>'totalMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'totalMs')::numeric END) FILTER (
         WHERE event_name = 'draft_confirm_processing_completed'
       )::float AS avg_confirm_total_ms,
       PERCENTILE_CONT(0.95) WITHIN GROUP (
         ORDER BY CASE WHEN metadata->>'totalMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'totalMs')::numeric END
       ) FILTER (
         WHERE event_name = 'draft_confirm_processing_completed'
           AND metadata->>'totalMs' ~ '^[0-9]+(\\.[0-9]+)?$'
       )::float AS p95_confirm_total_ms,
       AVG(CASE WHEN metadata->>'dbSaveMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'dbSaveMs')::numeric END) FILTER (
         WHERE event_name = 'draft_confirm_processing_completed'
       )::float AS avg_confirm_db_save_ms,
       PERCENTILE_CONT(0.95) WITHIN GROUP (
         ORDER BY CASE WHEN metadata->>'dbSaveMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'dbSaveMs')::numeric END
       ) FILTER (
         WHERE event_name = 'draft_confirm_processing_completed'
           AND metadata->>'dbSaveMs' ~ '^[0-9]+(\\.[0-9]+)?$'
       )::float AS p95_confirm_db_save_ms,
       AVG(CASE WHEN metadata->>'telegramUpdateMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'telegramUpdateMs')::numeric END) FILTER (
         WHERE event_name = 'draft_confirm_processing_completed'
       )::float AS avg_confirm_telegram_update_ms,
       PERCENTILE_CONT(0.95) WITHIN GROUP (
         ORDER BY CASE WHEN metadata->>'telegramUpdateMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'telegramUpdateMs')::numeric END
       ) FILTER (
         WHERE event_name = 'draft_confirm_processing_completed'
           AND metadata->>'telegramUpdateMs' ~ '^[0-9]+(\\.[0-9]+)?$'
       )::float AS p95_confirm_telegram_update_ms,
       AVG(CASE
         WHEN metadata->>'processingTotalMs' ~ '^[0-9]+(\\.[0-9]+)?$'
         THEN (metadata->>'processingTotalMs')::numeric
       END) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'inputType' = 'text'
       )::float AS avg_text_processing_ms,
       PERCENTILE_CONT(0.95) WITHIN GROUP (
         ORDER BY CASE WHEN metadata->>'processingTotalMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'processingTotalMs')::numeric END
       ) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'inputType' = 'text'
           AND metadata->>'processingTotalMs' ~ '^[0-9]+(\\.[0-9]+)?$'
       )::float AS p95_text_processing_ms,
       AVG(CASE
         WHEN metadata->>'processingTotalMs' ~ '^[0-9]+(\\.[0-9]+)?$'
         THEN (metadata->>'processingTotalMs')::numeric
       END) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'inputType' = 'voice'
       )::float AS avg_voice_processing_ms,
       PERCENTILE_CONT(0.95) WITHIN GROUP (
         ORDER BY CASE WHEN metadata->>'processingTotalMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'processingTotalMs')::numeric END
       ) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'inputType' = 'voice'
           AND metadata->>'processingTotalMs' ~ '^[0-9]+(\\.[0-9]+)?$'
       )::float AS p95_voice_processing_ms,
       AVG(CASE WHEN metadata->>'queueWaitMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'queueWaitMs')::numeric END) FILTER (
         WHERE event_name = 'message_processing_completed' AND metadata->>'inputType' = 'text'
       )::float AS avg_text_queue_wait_ms,
       AVG(CASE WHEN metadata->>'telegramResponseMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'telegramResponseMs')::numeric END) FILTER (
         WHERE event_name = 'message_processing_completed' AND metadata->>'inputType' = 'text'
       )::float AS avg_text_telegram_response_ms,
       AVG(CASE WHEN metadata->>'llmParseMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'llmParseMs')::numeric END) FILTER (
         WHERE event_name = 'message_processing_completed' AND metadata->>'inputType' = 'text'
       )::float AS avg_text_llm_parse_ms,
       PERCENTILE_CONT(0.95) WITHIN GROUP (
         ORDER BY CASE WHEN metadata->>'llmParseMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'llmParseMs')::numeric END
       ) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'inputType' = 'text'
           AND metadata->>'llmParseMs' ~ '^[0-9]+(\\.[0-9]+)?$'
       )::float AS p95_text_llm_parse_ms,
       AVG(CASE WHEN metadata->>'dbSaveMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'dbSaveMs')::numeric END) FILTER (
         WHERE event_name = 'message_processing_completed' AND metadata->>'inputType' = 'text'
       )::float AS avg_text_db_save_ms,
       PERCENTILE_CONT(0.95) WITHIN GROUP (
         ORDER BY CASE WHEN metadata->>'dbSaveMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'dbSaveMs')::numeric END
       ) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'inputType' = 'text'
           AND metadata->>'dbSaveMs' ~ '^[0-9]+(\\.[0-9]+)?$'
       )::float AS p95_text_db_save_ms,
       AVG(CASE WHEN metadata->>'queueWaitMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'queueWaitMs')::numeric END) FILTER (
         WHERE event_name = 'message_processing_completed' AND metadata->>'inputType' = 'voice'
       )::float AS avg_voice_queue_wait_ms,
       AVG(CASE WHEN metadata->>'telegramFileDownloadMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'telegramFileDownloadMs')::numeric END) FILTER (
         WHERE event_name = 'message_processing_completed' AND metadata->>'inputType' = 'voice'
       )::float AS avg_voice_telegram_file_download_ms,
       PERCENTILE_CONT(0.95) WITHIN GROUP (
         ORDER BY CASE WHEN metadata->>'telegramFileDownloadMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'telegramFileDownloadMs')::numeric END
       ) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'inputType' = 'voice'
           AND metadata->>'telegramFileDownloadMs' ~ '^[0-9]+(\\.[0-9]+)?$'
       )::float AS p95_voice_telegram_file_download_ms,
       AVG(CASE WHEN metadata->>'transcriptionMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'transcriptionMs')::numeric END) FILTER (
         WHERE event_name = 'message_processing_completed' AND metadata->>'inputType' = 'voice'
       )::float AS avg_voice_transcription_ms,
       PERCENTILE_CONT(0.95) WITHIN GROUP (
         ORDER BY CASE WHEN metadata->>'transcriptionMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'transcriptionMs')::numeric END
       ) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'inputType' = 'voice'
           AND metadata->>'transcriptionMs' ~ '^[0-9]+(\\.[0-9]+)?$'
       )::float AS p95_voice_transcription_ms,
       AVG(CASE WHEN metadata->>'llmParseMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'llmParseMs')::numeric END) FILTER (
         WHERE event_name = 'message_processing_completed' AND metadata->>'inputType' = 'voice'
       )::float AS avg_voice_llm_parse_ms,
       PERCENTILE_CONT(0.95) WITHIN GROUP (
         ORDER BY CASE WHEN metadata->>'llmParseMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'llmParseMs')::numeric END
       ) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'inputType' = 'voice'
           AND metadata->>'llmParseMs' ~ '^[0-9]+(\\.[0-9]+)?$'
       )::float AS p95_voice_llm_parse_ms,
       AVG(CASE WHEN metadata->>'telegramResponseMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'telegramResponseMs')::numeric END) FILTER (
         WHERE event_name = 'message_processing_completed' AND metadata->>'inputType' = 'voice'
       )::float AS avg_voice_telegram_response_ms,
       AVG(CASE WHEN metadata->>'dbSaveMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'dbSaveMs')::numeric END) FILTER (
         WHERE event_name = 'message_processing_completed' AND metadata->>'inputType' = 'voice'
       )::float AS avg_voice_db_save_ms,
       PERCENTILE_CONT(0.95) WITHIN GROUP (
         ORDER BY CASE WHEN metadata->>'dbSaveMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'dbSaveMs')::numeric END
       ) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'inputType' = 'voice'
           AND metadata->>'dbSaveMs' ~ '^[0-9]+(\\.[0-9]+)?$'
       )::float AS p95_voice_db_save_ms,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'parserEngine' = 'local-fast-path'
       )::int AS local_fast_path_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'localCandidate' = 'true'
       )::int AS local_candidate_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'localAcceptanceLevel' IN ('local_safe', 'local_reviewable')
       )::int AS local_accepted_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'parserRoute' = 'local_primary'
       )::int AS local_primary_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'localAcceptanceLevel' = 'local_safe'
       )::int AS local_safe_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'localAcceptanceLevel' = 'local_reviewable'
       )::int AS local_reviewable_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'parserRoute' = 'local_reviewable_llm'
       )::int AS local_reviewable_llm_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'parserRoute' = 'llm_error_local_reviewable_fallback'
       )::int AS local_reviewable_fallback_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'localAcceptanceLevel' = 'local_rejected'
       )::int AS local_rejected_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'parserRoute' = 'local_rejected_fallback'
       )::int AS local_rejected_fallback_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'parserRoute' = 'local_exception_fallback'
       )::int AS local_exception_fallback_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'parserRoute' = 'rollout_excluded'
       )::int AS rollout_excluded_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'parserRoute' = 'non_expense_guard'
       )::int AS non_expense_guard_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'parserEngine' = 'llm'
       )::int AS llm_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND COALESCE(metadata->>'parserRoute', 'llm_primary') = 'llm_primary'
           AND metadata->>'parserEngine' = 'llm'
       )::int AS llm_primary_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'llmSkipped' = 'true'
       )::int AS llm_skipped_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'parserEngine' = 'llm'
           AND metadata->>'parserRoute' IN ('local_rejected_fallback', 'local_exception_fallback')
       )::int AS llm_fallback_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'categoryResolution' = 'needs_user_review'
       )::int AS category_needs_review_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'shadowDisagreement' = 'true'
       )::int AS shadow_disagreement_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata ? 'shadowDisagreement'
           AND metadata->>'shadowDisagreement' IN ('true', 'false')
       )::int AS shadow_compared_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'criticalShadowDisagreement' = 'true'
       )::int AS critical_shadow_disagreement_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'categoryOnlyShadowDisagreement' = 'true'
       )::int AS category_only_shadow_disagreement_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->'shadowDisagreementFields' ? 'amount'
       )::int AS amount_shadow_disagreement_count,
       COUNT(*) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->'shadowDisagreementFields' ? 'currency'
       )::int AS currency_shadow_disagreement_count,
       AVG(CASE WHEN metadata->>'localParseMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'localParseMs')::numeric END)::float AS avg_local_parse_ms,
       PERCENTILE_CONT(0.95) WITHIN GROUP (
         ORDER BY CASE WHEN metadata->>'localParseMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'localParseMs')::numeric END
       ) FILTER (WHERE metadata->>'localParseMs' ~ '^[0-9]+(\\.[0-9]+)?$')::float AS p95_local_parse_ms,
       AVG(CASE WHEN metadata->>'llmHttpMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'llmHttpMs')::numeric END)::float AS avg_llm_http_ms,
       PERCENTILE_CONT(0.95) WITHIN GROUP (
         ORDER BY CASE WHEN metadata->>'llmHttpMs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'llmHttpMs')::numeric END
       ) FILTER (WHERE metadata->>'llmHttpMs' ~ '^[0-9]+(\\.[0-9]+)?$')::float AS p95_llm_http_ms,
       AVG(CASE
         WHEN metadata->>'processingTotalMs' ~ '^[0-9]+(\\.[0-9]+)?$'
         THEN (metadata->>'processingTotalMs')::numeric
       END) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'parserEngine' = 'local-fast-path'
       )::float AS avg_local_fast_path_processing_ms,
       AVG(CASE
         WHEN metadata->>'processingTotalMs' ~ '^[0-9]+(\\.[0-9]+)?$'
         THEN (metadata->>'processingTotalMs')::numeric
       END) FILTER (
         WHERE event_name = 'message_processing_completed'
           AND metadata->>'parserEngine' = 'llm'
       )::float AS avg_llm_processing_ms,
       (
         SELECT COALESCE(jsonb_object_agg(reason, count), '{}'::jsonb)
         FROM (
           SELECT metadata->>'localFastPathRejectReason' AS reason, COUNT(*)::int AS count
           FROM app_events
           WHERE created_at >= $1 AND created_at < $2
             AND event_name = 'message_processing_completed'
             AND metadata->>'localFastPathRejectReason' IS NOT NULL
           GROUP BY reason
         ) reject_reasons
       ) AS local_fast_path_reject_reasons,
       (
         SELECT COALESCE(jsonb_object_agg(field, count), '{}'::jsonb)
         FROM (
           SELECT field, COUNT(*)::int AS count
           FROM app_events,
             LATERAL jsonb_array_elements_text(
               CASE
                 WHEN jsonb_typeof(metadata->'shadowDisagreementFields') = 'array'
                 THEN metadata->'shadowDisagreementFields'
                 ELSE '[]'::jsonb
               END
             ) AS field
           WHERE created_at >= $1 AND created_at < $2
             AND event_name = 'message_processing_completed'
           GROUP BY field
         ) disagreement_fields
       ) AS shadow_disagreement_fields
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
    confirmAttempts: numeric(row.confirm_attempts),
    confirmSuccessCount: numeric(row.confirm_success_count),
    confirmAlreadySavedCount: numeric(row.confirm_already_saved_count),
    confirmCancelledCount: numeric(row.confirm_cancelled_count),
    confirmCategoryRequiredCount: numeric(row.confirm_category_required_count),
    confirmFailedCount: numeric(row.confirm_failed_count),
    avgConfirmCallbackAckMs: nullableNumeric(row.avg_confirm_callback_ack_ms),
    p95ConfirmCallbackAckMs: nullableNumeric(row.p95_confirm_callback_ack_ms),
    avgConfirmUserResultMs: nullableNumeric(row.avg_confirm_user_result_ms),
    p95ConfirmUserResultMs: nullableNumeric(row.p95_confirm_user_result_ms),
    avgConfirmTotalMs: nullableNumeric(row.avg_confirm_total_ms),
    p95ConfirmTotalMs: nullableNumeric(row.p95_confirm_total_ms),
    avgConfirmDbSaveMs: nullableNumeric(row.avg_confirm_db_save_ms),
    p95ConfirmDbSaveMs: nullableNumeric(row.p95_confirm_db_save_ms),
    avgConfirmTelegramUpdateMs: nullableNumeric(row.avg_confirm_telegram_update_ms),
    p95ConfirmTelegramUpdateMs: nullableNumeric(row.p95_confirm_telegram_update_ms),
    avgTextProcessingMs: nullableNumeric(row.avg_text_processing_ms),
    avgVoiceProcessingMs: nullableNumeric(row.avg_voice_processing_ms),
    p95TextProcessingMs: nullableNumeric(row.p95_text_processing_ms),
    p95VoiceProcessingMs: nullableNumeric(row.p95_voice_processing_ms),
    avgTextQueueWaitMs: nullableNumeric(row.avg_text_queue_wait_ms),
    avgTextTelegramResponseMs: nullableNumeric(row.avg_text_telegram_response_ms),
    avgTextLlmParseMs: nullableNumeric(row.avg_text_llm_parse_ms),
    p95TextLlmParseMs: nullableNumeric(row.p95_text_llm_parse_ms),
    avgTextDbSaveMs: nullableNumeric(row.avg_text_db_save_ms),
    p95TextDbSaveMs: nullableNumeric(row.p95_text_db_save_ms),
    avgVoiceQueueWaitMs: nullableNumeric(row.avg_voice_queue_wait_ms),
    avgVoiceTelegramFileDownloadMs: nullableNumeric(row.avg_voice_telegram_file_download_ms),
    p95VoiceTelegramFileDownloadMs: nullableNumeric(row.p95_voice_telegram_file_download_ms),
    avgVoiceTranscriptionMs: nullableNumeric(row.avg_voice_transcription_ms),
    p95VoiceTranscriptionMs: nullableNumeric(row.p95_voice_transcription_ms),
    avgVoiceLlmParseMs: nullableNumeric(row.avg_voice_llm_parse_ms),
    p95VoiceLlmParseMs: nullableNumeric(row.p95_voice_llm_parse_ms),
    avgVoiceTelegramResponseMs: nullableNumeric(row.avg_voice_telegram_response_ms),
    avgVoiceDbSaveMs: nullableNumeric(row.avg_voice_db_save_ms),
    p95VoiceDbSaveMs: nullableNumeric(row.p95_voice_db_save_ms),
    localFastPathCount: numeric(row.local_fast_path_count),
    localCandidateCount: numeric(row.local_candidate_count),
    localAcceptedCount: numeric(row.local_accepted_count),
    localPrimaryCount: numeric(row.local_primary_count),
    localSafeCount: numeric(row.local_safe_count),
    localReviewableCount: numeric(row.local_reviewable_count),
    localReviewableLlmCount: numeric(row.local_reviewable_llm_count),
    localReviewableFallbackCount: numeric(row.local_reviewable_fallback_count),
    localRejectedCount: numeric(row.local_rejected_count),
    localRejectedFallbackCount: numeric(row.local_rejected_fallback_count),
    localExceptionFallbackCount: numeric(row.local_exception_fallback_count),
    rolloutExcludedCount: numeric(row.rollout_excluded_count),
    nonExpenseGuardCount: numeric(row.non_expense_guard_count),
    llmCount: numeric(row.llm_count),
    llmPrimaryCount: numeric(row.llm_primary_count),
    llmSkippedCount: numeric(row.llm_skipped_count),
    llmFallbackCount: numeric(row.llm_fallback_count),
    categoryNeedsReviewCount: numeric(row.category_needs_review_count),
    shadowDisagreementCount: numeric(row.shadow_disagreement_count),
    shadowComparedCount: numeric(row.shadow_compared_count),
    criticalShadowDisagreementCount: numeric(row.critical_shadow_disagreement_count),
    categoryOnlyShadowDisagreementCount: numeric(row.category_only_shadow_disagreement_count),
    amountShadowDisagreementCount: numeric(row.amount_shadow_disagreement_count),
    currencyShadowDisagreementCount: numeric(row.currency_shadow_disagreement_count),
    avgLocalParseMs: nullableNumeric(row.avg_local_parse_ms),
    p95LocalParseMs: nullableNumeric(row.p95_local_parse_ms),
    avgLlmHttpMs: nullableNumeric(row.avg_llm_http_ms),
    p95LlmHttpMs: nullableNumeric(row.p95_llm_http_ms),
    avgLocalFastPathProcessingMs: nullableNumeric(row.avg_local_fast_path_processing_ms),
    avgLlmProcessingMs: nullableNumeric(row.avg_llm_processing_ms),
    localFastPathRejectReasons: row.local_fast_path_reject_reasons,
    shadowDisagreementFields: row.shadow_disagreement_fields
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
    ...(options.includeConfirmFlow ? formatConfirmFlow(period.confirmFlow) : []),
    `Avg processing: text ${formatSeconds(period.avgTextProcessingSeconds)} / voice ${formatSeconds(period.avgVoiceProcessingSeconds)}`,
    `P95 processing: text ${formatSeconds(period.p95TextProcessingSeconds)} / voice ${formatSeconds(period.p95VoiceProcessingSeconds)}`,
    formatTextStages(period.avgTextStageSeconds),
    formatVoiceStages(period.avgVoiceStageSeconds),
    formatTextP95Stages(period.p95TextStageSeconds),
    formatVoiceP95Stages(period.p95VoiceStageSeconds),
    `Parser: local ${period.localFastPathCount} / LLM ${period.llmCount} / skipped ${period.llmSkippedCount}`,
    `Parser routing: local primary ${period.localPrimaryCount ?? 0} / local->LLM ${period.localRejectedFallbackCount ?? 0} / LLM primary ${period.llmPrimaryCount ?? 0} / local exceptions ${period.localExceptionFallbackCount ?? 0} / excluded ${period.rolloutExcludedCount ?? 0} / guard ${period.nonExpenseGuardCount ?? 0}`,
    `Parser avg: local ${formatSeconds(period.avgLocalFastPathProcessingSeconds)} / LLM ${formatSeconds(period.avgLlmProcessingSeconds)}`,
    `Local acceptance: ${numeric(period.localCandidateCount)} candidates / ${numeric(period.localAcceptedCount)} accepted / ${numeric(period.localPrimaryCount)} primary`,
    `Levels: safe ${numeric(period.localSafeCount)} / reviewable ${numeric(period.localReviewableCount)} / rejected ${numeric(period.localRejectedCount)}`,
    `Reviewable route: LLM ${numeric(period.localReviewableLlmCount)} / fallback ${numeric(period.localReviewableFallbackCount)}`,
    `LLM fallback: ${numeric(period.llmFallbackCount)}`,
    `Internal latency avg/P95: local ${formatInternalSeconds(period.avgLocalParseSeconds)}/${formatInternalSeconds(period.p95LocalParseSeconds)} / LLM HTTP ${formatInternalSeconds(period.avgLlmHttpSeconds)}/${formatInternalSeconds(period.p95LlmHttpSeconds)}`,
    `Review: category ${period.categoryNeedsReviewCount}`,
    `Shadow: ${period.shadowDisagreementCount}/${period.shadowComparedCount} disagreements`,
    `Critical shadow: ${formatShadowRate(period.criticalShadowDisagreementCount, period.shadowComparedCount, period.criticalShadowDisagreementRate)}`,
    `Category-only shadow: ${formatShadowRate(period.categoryOnlyShadowDisagreementCount, period.shadowComparedCount, period.categoryOnlyShadowDisagreementRate)}`,
    `Amount/currency shadow: ${formatShadowRate(period.amountShadowDisagreementCount, period.shadowComparedCount, period.amountShadowDisagreementRate)} / ${formatShadowRate(period.currencyShadowDisagreementCount, period.shadowComparedCount, period.currencyShadowDisagreementRate)}`,
    ...formatMapLine("Rejects", period.localFastPathRejectReasons),
    ...formatMapLine("Shadow fields", period.shadowDisagreementFields)
  ].join("\n");
}

function disagreementRate(count, sample) {
  const denominator = numeric(sample);
  if (denominator <= 0) return null;
  return Math.round((numeric(count) / denominator) * 1000) / 10;
}

function formatShadowRate(count, sample, rate) {
  const sampleCount = numeric(sample);
  const label = sampleCount < 100 ? "insufficient sample" : `${rate ?? disagreementRate(count, sampleCount)}%`;
  return `${numeric(count)}/${sampleCount} (${label})`;
}

function formatConfirmFlow(flow = {}) {
  if (numeric(flow.attempts) <= 0) return [];
  const avg = formatConfirmLatencyLine("Confirm avg", [
    ["ACK", flow.avgCallbackAckSeconds],
    ["Result", flow.avgUserResultSeconds],
    ["Total", flow.avgTotalSeconds],
    ["DB", flow.avgDbSaveSeconds],
    ["Telegram", flow.avgTelegramUpdateSeconds]
  ]);
  const p95 = formatConfirmLatencyLine("Confirm P95", [
    ["ACK", flow.p95CallbackAckSeconds],
    ["Result", flow.p95UserResultSeconds],
    ["Total", flow.p95TotalSeconds],
    ["DB", flow.p95DbSaveSeconds],
    ["Telegram", flow.p95TelegramUpdateSeconds]
  ]);
  return [
    `Confirm flow: ${numeric(flow.attempts)} attempts`,
    `Confirm outcomes: success ${numeric(flow.success)} / already_saved ${numeric(flow.alreadySaved)} / cancelled ${numeric(flow.cancelled)} / category_required ${numeric(flow.categoryRequired)} / failed ${numeric(flow.failed)}`,
    ...[avg, p95].filter(Boolean)
  ];
}

function formatConfirmLatencyLine(label, metrics) {
  const values = metrics
    .filter(([, value]) => value != null)
    .map(([name, value]) => `${name} ${formatSeconds(value)}`);
  return values.length > 0 ? `${label}: ${values.join(" / ")}` : null;
}

function fallbackCount(primary, fallback) {
  return Number(primary) > 0 ? Number(primary) : Number(fallback);
}

function secondsOrNull(value) {
  const number = nullableNumeric(value);
  return number == null ? null : Math.round((number / 1000) * 10) / 10;
}

function millisecondsToSeconds(value) {
  const number = nullableNumeric(value);
  return number == null ? null : number / 1000;
}

function formatInternalSeconds(value) {
  return value == null ? "-" : `${Number(value).toFixed(3)}s`;
}

function formatSeconds(value) {
  return value == null ? "-" : `${Number(value).toFixed(1)}s`;
}

function formatTextStages(stages = {}) {
  return `Avg stages text: queue ${formatSeconds(stages.queue)} / tg ${formatSeconds(stages.telegramResponse)} / llm ${formatSeconds(stages.llmParse)} / db ${formatSeconds(stages.dbSave)}`;
}

function formatVoiceStages(stages = {}) {
  return `Avg stages voice: queue ${formatSeconds(stages.queue)} / dl ${formatSeconds(stages.telegramFileDownload)} / asr ${formatSeconds(stages.transcription)} / llm ${formatSeconds(stages.llmParse)} / tg ${formatSeconds(stages.telegramResponse)} / db ${formatSeconds(stages.dbSave)}`;
}

function formatTextP95Stages(stages = {}) {
  return `P95 stages text: llm ${formatSeconds(stages.llmParse)} / db ${formatSeconds(stages.dbSave)}`;
}

function formatVoiceP95Stages(stages = {}) {
  return `P95 stages voice: dl ${formatSeconds(stages.telegramFileDownload)} / asr ${formatSeconds(stages.transcription)} / llm ${formatSeconds(stages.llmParse)} / db ${formatSeconds(stages.dbSave)}`;
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

function objectFromJson(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function formatMapLine(label, value) {
  const entries = Object.entries(objectFromJson(value));
  if (entries.length === 0) return [];
  const formatted = entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${key} ${count}`)
    .join(" / ");
  return [`${label}: ${formatted}`];
}
