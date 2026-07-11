import test from "node:test";
import assert from "node:assert/strict";

import { createTechnicalStatsService, formatTechnicalStats, formatTechnicalStatsSections } from "../src/technicalStatsService.js";
import { formatAdminMessageParts } from "../src/adminStatsService.js";

test("technical stats are limited to Today and Last 7 days", async () => {
  const periods = [];
  const service = createTechnicalStatsService({
    pool: {
      async query(sql, params = []) {
        const text = String(sql);
        if (text.includes("information_schema.columns")) return { rows: [{ exists: true }] };
        if (params[0] instanceof Date) periods.push(params[0]);
        if (text.includes("FROM users")) return { rows: [{ new_users: 0 }] };
        return { rows: [{}] };
      }
    },
    now: () => new Date("2026-07-10T10:00:00Z")
  });

  const stats = await service.getTechnicalStats();

  assert.deepEqual(Object.keys(stats), ["generatedAt", "today", "last7Days"]);
  assert.ok(periods.length > 0);
});

test("technical formatter includes generated time emojis and bold KPIs", () => {
  const period = {
    activeUsers: 2, newUsers: 1, messagesTotal: 3, textMessages: 3, voiceMessages: 0,
    photoMessages: 0, expensesSaved: 1, draftsCreated: 1, draftsConfirmed: 1,
    draftsCancelled: 0, parseFailed: 0, transcriptionFailed: 0, confirmRate: 1,
    parseFailedRate: 0, avgTextStageSeconds: {}, avgVoiceStageSeconds: {},
    p95TextStageSeconds: {}, p95VoiceStageSeconds: {}, localFastPathRejectReasons: {},
    shadowDisagreementFields: {}
  };
  const parts = formatAdminMessageParts(formatTechnicalStatsSections({
    generatedAt: new Date("2026-07-10T10:00:00Z"), today: period, last7Days: period
  }));
  const html = parts.map((part) => part.html).join("\n");

  assert.match(html, /<b>🛠 Technical stats<\/b>/);
  assert.match(html, /Generated: <code>2026-07-10 10:00 UTC<\/code>/);
  assert.match(html, /Users: <b>2 active<\/b>/);
});

test("technical formatter omits the old Last 30 days section", () => {
  const period = {
    activeUsers: 0, newUsers: 0, messagesTotal: 0, textMessages: 0, voiceMessages: 0,
    photoMessages: 0, expensesSaved: 0, draftsCreated: 0, draftsConfirmed: 0,
    draftsCancelled: 0, parseFailed: 0, transcriptionFailed: 0, confirmRate: null,
    parseFailedRate: null, avgTextStageSeconds: {}, avgVoiceStageSeconds: {},
    p95TextStageSeconds: {}, p95VoiceStageSeconds: {}, localFastPathRejectReasons: {},
    shadowDisagreementFields: {}
  };
  const text = formatTechnicalStats({ today: period, last7Days: period });
  assert.match(text, /Today:/);
  assert.match(text, /Last 7 days:/);
  assert.doesNotMatch(text, /Last 30 days:/);
});
