import test from "node:test";
import assert from "node:assert/strict";

import { createAdminStatsService, formatAdminStats, parseAdminTelegramIds } from "../src/adminStatsService.js";

test("parses comma-separated admin Telegram ids with whitespace", () => {
  assert.deepEqual(parseAdminTelegramIds(" 123456789, 987654321 ,, bad "), new Set([123456789, 987654321]));
  assert.deepEqual(parseAdminTelegramIds(""), new Set());
  assert.deepEqual(parseAdminTelegramIds(undefined), new Set());
});

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
          avg_voice_processing_ms: 4800
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
  assert.equal(stats.today.confirmRate, 60);
  assert.equal(stats.today.parseFailedRate, 33);
  assert.equal(stats.today.avgTextProcessingSeconds, 1.4);
  assert.equal(stats.today.avgVoiceProcessingSeconds, 4.8);
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

test("formats admin stats as a compact Telegram message", () => {
  const text = formatAdminStats({
    today: emptyPeriod({ activeUsers: 5, newUsers: 1, messagesTotal: 43, textMessages: 31, voiceMessages: 12, expensesSaved: 28, draftsCreated: 32, draftsConfirmed: 25, draftsCancelled: 3, parseFailed: 2, transcriptionFailed: 1, avgTextProcessingSeconds: 1.4, avgVoiceProcessingSeconds: 4.8 }),
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
  assert.match(text, /Last 30 days:/);
  assert.match(text, /Confirm rate: -/);
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
