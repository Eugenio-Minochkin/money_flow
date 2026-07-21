import test from "node:test";
import assert from "node:assert/strict";

import {
  createTechnicalStatsService,
  formatTechnicalStats as formatAdminStats,
  formatTechnicalStatsSections
} from "../src/technicalStatsService.js";

test("admin processing diagnostics expose avg and p95 totals plus key stages", async () => {
  const service = createTechnicalStatsService({
    pool: fakePool((sql) => {
      const query = String(sql);
      if (query.includes("information_schema.columns")) return { rows: [{ exists: true }] };
      if (query.includes("FROM users")) return { rows: [{ new_users: 0 }] };
      if (query.includes("FROM expenses")) {
        return {
          rows: [{
            expenses_saved: 0,
            drafts_created: 0,
            drafts_confirmed: 0,
            drafts_cancelled: 0
          }]
        };
      }
      assert.match(query, /PERCENTILE_CONT\(0\.95\)/);
      assert.match(query, /message_processing_completed/);
      assert.match(query, /telegramFileDownloadMs/);
      assert.match(query, /transcriptionMs/);
      assert.match(query, /llmParseMs/);
      assert.match(query, /dbSaveMs/);
      return {
        rows: [{
          active_users: 1,
          message_received: 5,
          text_direct: 0,
          text_from_message: 3,
          voice_direct: 0,
          voice_from_message: 2,
          photo_direct: 0,
          photo_from_message: 0,
          expenses_saved: 0,
          drafts_created: 0,
          drafts_confirmed: 0,
          drafts_cancelled: 0,
          parse_failed: 0,
          transcription_failed: 0,
          avg_text_processing_ms: 1200,
          p95_text_processing_ms: 1900,
          avg_voice_processing_ms: 5200,
          p95_voice_processing_ms: 8100,
          avg_text_queue_wait_ms: 100,
          avg_text_telegram_response_ms: 200,
          avg_text_llm_parse_ms: 700,
          p95_text_llm_parse_ms: 1300,
          avg_text_db_save_ms: 120,
          p95_text_db_save_ms: 260,
          avg_voice_queue_wait_ms: 180,
          avg_voice_telegram_file_download_ms: 900,
          p95_voice_telegram_file_download_ms: 1600,
          avg_voice_transcription_ms: 2800,
          p95_voice_transcription_ms: 4200,
          avg_voice_llm_parse_ms: 850,
          p95_voice_llm_parse_ms: 1500,
          avg_voice_telegram_response_ms: 250,
          avg_voice_db_save_ms: 190,
          p95_voice_db_save_ms: 410
        }]
      };
    }),
    now: () => new Date("2026-06-24T10:00:00.000Z")
  });

  const stats = await service.getTechnicalStats();

  assert.equal(stats.today.avgTextProcessingSeconds, 1.2);
  assert.equal(stats.today.p95TextProcessingSeconds, 1.9);
  assert.equal(stats.today.avgVoiceProcessingSeconds, 5.2);
  assert.equal(stats.today.p95VoiceProcessingSeconds, 8.1);
  assert.deepEqual(stats.today.p95TextStageSeconds, {
    llmParse: 1.3,
    dbSave: 0.3
  });
  assert.deepEqual(stats.today.p95VoiceStageSeconds, {
    telegramFileDownload: 1.6,
    transcription: 4.2,
    llmParse: 1.5,
    dbSave: 0.4
  });
});

test("formatted admin stats include p95 processing summary", () => {
  const text = formatAdminStats({
    today: period({
      avgTextProcessingSeconds: 1.2,
      p95TextProcessingSeconds: 1.9,
      avgVoiceProcessingSeconds: 5.2,
      p95VoiceProcessingSeconds: 8.1,
      p95TextStageSeconds: { llmParse: 1.3, dbSave: 0.3 },
      p95VoiceStageSeconds: { telegramFileDownload: 1.6, transcription: 4.2, llmParse: 1.5, dbSave: 0.4 }
    }),
    last7Days: period(),
    last30Days: period()
  });

  assert.match(text, /P95 processing: text 1\.9s \/ voice 8\.1s/);
  assert.match(text, /P95 stages text: llm 1\.3s \/ db 0\.3s/);
  assert.match(text, /P95 stages voice: dl 1\.6s \/ asr 4\.2s \/ llm 1\.5s \/ db 0\.4s/);
});

test("confirm-flow diagnostics aggregate outcomes and only numeric latency metadata", async () => {
  const service = createTechnicalStatsService({
    pool: fakePool((sql) => {
      const query = String(sql);
      if (query.includes("information_schema.columns")) return { rows: [{ exists: true }] };
      if (query.includes("FROM users")) return { rows: [{ new_users: 0 }] };
      if (query.includes("FROM expenses")) {
        return { rows: [{ expenses_saved: 0, drafts_created: 0, drafts_confirmed: 0, drafts_cancelled: 0 }] };
      }
      assert.match(query, /draft_confirm_processing_completed/);
      for (const field of ["callbackAckMs", "userResultMs", "totalMs", "dbSaveMs", "telegramUpdateMs"]) {
        assert.ok(query.includes(`metadata->>'${field}' ~ '^[0-9]+`));
      }
      return {
        rows: [{
          confirm_attempts: 5,
          confirm_success_count: 1,
          confirm_already_saved_count: 1,
          confirm_cancelled_count: 1,
          confirm_category_required_count: 1,
          confirm_failed_count: 1,
          avg_confirm_callback_ack_ms: 120,
          p95_confirm_callback_ack_ms: 180,
          avg_confirm_user_result_ms: 1600,
          p95_confirm_user_result_ms: 1950,
          avg_confirm_total_ms: 1900,
          p95_confirm_total_ms: 2300,
          avg_confirm_db_save_ms: 1100,
          p95_confirm_db_save_ms: 1400,
          avg_confirm_telegram_update_ms: 300,
          p95_confirm_telegram_update_ms: 450
        }]
      };
    }),
    now: () => new Date("2026-06-24T10:00:00.000Z")
  });

  const stats = await service.getTechnicalStats();

  assert.deepEqual(stats.today.confirmFlow, {
    attempts: 5,
    success: 1,
    alreadySaved: 1,
    cancelled: 1,
    categoryRequired: 1,
    failed: 1,
    avgCallbackAckSeconds: 0.1,
    p95CallbackAckSeconds: 0.2,
    avgUserResultSeconds: 1.6,
    p95UserResultSeconds: 2,
    avgTotalSeconds: 1.9,
    p95TotalSeconds: 2.3,
    avgDbSaveSeconds: 1.1,
    p95DbSaveSeconds: 1.4,
    avgTelegramUpdateSeconds: 0.3,
    p95TelegramUpdateSeconds: 0.5
  });
  assert.equal(
    stats.today.confirmFlow.success
      + stats.today.confirmFlow.alreadySaved
      + stats.today.confirmFlow.cancelled
      + stats.today.confirmFlow.categoryRequired
      + stats.today.confirmFlow.failed,
    stats.today.confirmFlow.attempts
  );
});

test("confirm-flow summary is optional and omits unavailable percentile values", () => {
  const stats = {
    generatedAt: new Date("2026-06-24T10:00:00.000Z"),
    today: period({
      confirmFlow: {
        attempts: 5,
        success: 1,
        alreadySaved: 1,
        cancelled: 1,
        categoryRequired: 1,
        failed: 1,
        avgCallbackAckSeconds: 0.1,
        p95CallbackAckSeconds: 0.2,
        avgUserResultSeconds: 1.6,
        p95UserResultSeconds: 2,
        avgTotalSeconds: 1.9,
        p95TotalSeconds: null,
        avgDbSaveSeconds: 1.1,
        p95DbSaveSeconds: null,
        avgTelegramUpdateSeconds: 0.3,
        p95TelegramUpdateSeconds: null
      }
    }),
    last7Days: period(),
    last30Days: period({
      confirmFlow: {
        attempts: 3,
        success: 3,
        alreadySaved: 0,
        cancelled: 0,
        categoryRequired: 0,
        failed: 0,
        avgCallbackAckSeconds: 0.1,
        p95CallbackAckSeconds: 0.2
      }
    })
  };

  const text = formatAdminStats(stats);
  const sections = formatTechnicalStatsSections(stats);

  assert.match(text, /Confirm flow: 5 attempts/);
  assert.match(text, /Confirm outcomes: success 1 \/ already_saved 1 \/ cancelled 1 \/ category_required 1 \/ failed 1/);
  assert.match(text, /Confirm avg: ACK 0\.1s \/ Result 1\.6s \/ Total 1\.9s \/ DB 1\.1s \/ Telegram 0\.3s/);
  assert.match(text, /Confirm P95: ACK 0\.2s \/ Result 2\.0s/);
  assert.doesNotMatch(text, /Total -|DB -|Telegram -/);
  assert.doesNotMatch(text, /Last 30 days|Confirm flow: 3 attempts/);
  assert.ok(sections.some((section) => section.heading.includes("Today") && section.heading.endsWith("Confirm flow")));

  const noAttempts = formatAdminStats({ ...stats, today: period(), last7Days: period() });
  assert.doesNotMatch(noAttempts, /Confirm flow:/);
});

function period(overrides = {}) {
  return {
    activeUsers: 0,
    newUsers: 0,
    messagesTotal: 0,
    textMessages: 0,
    voiceMessages: 0,
    photoMessages: 0,
    expensesSaved: 0,
    draftsCreated: 0,
    draftsConfirmed: 0,
    draftsCancelled: 0,
    parseFailed: 0,
    transcriptionFailed: 0,
    confirmRate: null,
    parseFailedRate: null,
    avgTextProcessingSeconds: null,
    avgVoiceProcessingSeconds: null,
    p95TextProcessingSeconds: null,
    p95VoiceProcessingSeconds: null,
    avgTextStageSeconds: {},
    avgVoiceStageSeconds: {},
    p95TextStageSeconds: {},
    p95VoiceStageSeconds: {},
    ...overrides
  };
}

function fakePool(handler) {
  return {
    async query(sql, params = []) {
      return handler(sql, params);
    }
  };
}
