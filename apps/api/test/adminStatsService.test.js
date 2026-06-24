import test from "node:test";
import assert from "node:assert/strict";

import { createAdminStatsService, formatAdminStats } from "../src/adminStatsService.js";

test("aggregates admin stats from app events and users", async () => {
  const queries = [];
  const service = createAdminStatsService({
    pool: fakePool((sql, params) => {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes("information_schema.columns")) {
        return { rows: [{ exists: true }] };
      }
      if (String(sql).includes("FROM users")) {
        return { rows: [{ new_users: 1 }] };
      }
      return {
        rows: [{
          active_users: 2,
          message_received: 0,
          text_direct: 3,
          text_from_message: 0,
          voice_direct: 2,
          voice_from_message: 0,
          photo_direct: 1,
          photo_from_message: 0,
          expenses_saved: 4,
          drafts_created: 5,
          drafts_confirmed: 3,
          drafts_cancelled: 1,
          parse_failed: 2,
          transcription_failed: 1,
          avg_text_processing_ms: 1400,
          avg_voice_processing_ms: 4800,
          avg_text_queue_wait_ms: 100,
          avg_text_telegram_response_ms: 200,
          avg_text_llm_parse_ms: 900,
          avg_text_db_save_ms: 300,
          avg_voice_queue_wait_ms: 150,
          avg_voice_telegram_file_download_ms: 1200,
          avg_voice_transcription_ms: 2600,
          avg_voice_llm_parse_ms: 800,
          avg_voice_telegram_response_ms: 250,
          avg_voice_db_save_ms: 350
        }]
      };
    }),
    now: () => new Date("2026-06-15T10:00:00.000Z")
  });

  const stats = await service.getAdminStats();

  assert.equal(stats.today.activeUsers, 2);
  assert.equal(stats.today.newUsers, 1);
  assert.equal(stats.today.messagesTotal, 6);
  assert.equal(stats.today.textMessages, 3);
  assert.equal(stats.today.voiceMessages, 2);
  assert.equal(stats.today.photoMessages, 1);
  assert.equal(stats.today.expensesSaved, 4);
  assert.equal(stats.today.draftsCreated, 5);
  assert.equal(stats.today.draftsConfirmed, 3);
  assert.equal(stats.today.draftsCancelled, 1);
  assert.equal(stats.today.confirmRate, 60);
  assert.equal(stats.today.parseFailedRate, 33);
  assert.equal(stats.today.avgTextProcessingSeconds, 1.4);
  assert.equal(stats.today.avgVoiceProcessingSeconds, 4.8);
  assert.deepEqual(stats.today.avgTextStageSeconds, {
    queue: 0.1,
    telegramResponse: 0.2,
    llmParse: 0.9,
    dbSave: 0.3
  });
  assert.deepEqual(stats.today.avgVoiceStageSeconds, {
    queue: 0.2,
    telegramFileDownload: 1.2,
    transcription: 2.6,
    llmParse: 0.8,
    telegramResponse: 0.3,
    dbSave: 0.4
  });
  assert.ok(queries.some((query) => query.params[0]?.toISOString() === "2026-06-14T17:00:00.000Z"));
});

test("falls back to first app event when users.created_at is unavailable", async () => {
  const service = createAdminStatsService({
    pool: fakePool((sql) => {
      if (String(sql).includes("information_schema.columns")) {
        return { rows: [{ exists: false }] };
      }
      if (String(sql).includes("MIN(created_at)")) {
        return { rows: [{ new_users: 2 }] };
      }
      return { rows: [{}] };
    }),
    now: () => new Date("2026-06-15T10:00:00.000Z")
  });

  const stats = await service.getAdminStats();

  assert.equal(stats.last7Days.newUsers, 2);
  assert.equal(stats.last7Days.messagesTotal, 0);
  assert.equal(stats.last7Days.avgTextProcessingSeconds, null);
  assert.equal(stats.last7Days.confirmRate, null);
});

test("falls back to historical expense and regular plus planned draft tables", async () => {
  const queries = [];
  const service = createAdminStatsService({
    pool: fakePool((sql) => {
      const query = String(sql);
      queries.push(query);
      if (query.includes("information_schema.columns")) {
        return { rows: [{ exists: true }] };
      }
      if (query.includes("FROM users")) {
        return { rows: [{ new_users: 1 }] };
      }
      if (query.includes("FROM app_events")) {
        return {
          rows: [{
            active_users: 0,
            message_received: 0,
            text_direct: 0,
            text_from_message: 0,
            voice_direct: 0,
            voice_from_message: 0,
            photo_direct: 0,
            photo_from_message: 0,
            expenses_saved: 0,
            drafts_created: 0,
            drafts_confirmed: 0,
            drafts_cancelled: 0,
            parse_failed: 0,
            transcription_failed: 0,
            avg_text_processing_ms: null,
            avg_voice_processing_ms: null,
            avg_text_queue_wait_ms: null,
            avg_text_telegram_response_ms: null,
            avg_text_llm_parse_ms: null,
            avg_text_db_save_ms: null,
            avg_voice_queue_wait_ms: null,
            avg_voice_telegram_file_download_ms: null,
            avg_voice_transcription_ms: null,
            avg_voice_llm_parse_ms: null,
            avg_voice_telegram_response_ms: null,
            avg_voice_db_save_ms: null
          }]
        };
      }
      if (query.includes("FROM expenses")) {
        return {
          rows: [{
            expenses_saved: 4,
            drafts_created: 7,
            drafts_confirmed: 5,
            drafts_cancelled: 2
          }]
        };
      }
      return { rows: [{}] };
    }),
    now: () => new Date("2026-06-15T10:00:00.000Z")
  });

  const stats = await service.getAdminStats();

  assert.equal(stats.today.newUsers, 1);
  assert.equal(stats.today.expensesSaved, 4);
  assert.equal(stats.today.draftsCreated, 7);
  assert.equal(stats.today.draftsConfirmed, 5);
  assert.equal(stats.today.draftsCancelled, 2);
  assert.equal(stats.today.confirmRate, 71);
  assert.ok(queries.some((query) => query.includes("planned_drafts")));
});

test("formats admin stats as a compact Telegram message", () => {
  const text = formatAdminStats({
    today: emptyPeriod({
      activeUsers: 5,
      newUsers: 1,
      messagesTotal: 43,
      textMessages: 31,
      voiceMessages: 12,
      expensesSaved: 28,
      draftsCreated: 32,
      draftsConfirmed: 25,
      draftsCancelled: 3,
      parseFailed: 2,
      transcriptionFailed: 1,
      avgTextProcessingSeconds: 1.4,
      avgVoiceProcessingSeconds: 4.8,
      avgTextStageSeconds: { queue: 0.1, telegramResponse: 0.2, llmParse: 0.9, dbSave: 0.3 },
      avgVoiceStageSeconds: { queue: 0.2, telegramFileDownload: 1.2, transcription: 2.6, llmParse: 0.8, telegramResponse: 0.3, dbSave: 0.4 }
    }),
    last7Days: emptyPeriod({ activeUsers: 9, newUsers: 3, messagesTotal: 210, textMessages: 160, voiceMessages: 48, photoMessages: 2, expensesSaved: 160, draftsCreated: 190, draftsConfirmed: 150, draftsCancelled: 20, confirmRate: 79, parseFailedRate: 4, avgTextProcessingSeconds: 1.5, avgVoiceProcessingSeconds: 5.1 }),
    last30Days: emptyPeriod()
  });

  assert.match(text, /^Admin stats/);
  assert.match(text, /Today:/);
  assert.match(text, /Users: 5 active \/ 1 new/);
  assert.match(text, /Messages: 43 total \/ 31 text \/ 12 voice \/ 0 photo/);
  assert.match(text, /Last 7 days:/);
  assert.match(text, /Confirm rate: 79%/);
  assert.match(text, /Avg processing: text 1.5s \/ voice 5.1s/);
  assert.match(text, /Avg stages text: queue 0.1s \/ tg 0.2s \/ llm 0.9s \/ db 0.3s/);
  assert.match(text, /Avg stages voice: queue 0.2s \/ dl 1.2s \/ asr 2.6s \/ llm 0.8s \/ tg 0.3s \/ db 0.4s/);
  assert.match(text, /Last 30 days:/);
  assert.match(text, /Confirm rate: -/);
  assert.match(text, /Avg stages text: queue - \/ tg - \/ llm - \/ db -/);
  assert.match(text, /Avg stages voice: queue - \/ dl - \/ asr - \/ llm - \/ tg - \/ db -/);
});

function emptyPeriod(overrides = {}) {
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
    avgTextProcessingSeconds: null,
    avgVoiceProcessingSeconds: null,
    avgTextStageSeconds: {},
    avgVoiceStageSeconds: {},
    confirmRate: null,
    parseFailedRate: null,
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
