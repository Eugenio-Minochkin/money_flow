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

test("technical stats aggregate parser acceptance timings fallbacks and shadow severity", async () => {
  const eventRow = {
    local_candidate_count: 12,
    local_accepted_count: 10,
    local_primary_count: 4,
    local_safe_count: 7,
    local_reviewable_count: 3,
    local_rejected_count: 2,
    llm_fallback_count: 5,
    avg_local_parse_ms: 2,
    p95_local_parse_ms: 4,
    avg_llm_http_ms: 100,
    p95_llm_http_ms: 220,
    shadow_compared_count: 120,
    critical_shadow_disagreement_count: 2,
    category_only_shadow_disagreement_count: 3,
    amount_shadow_disagreement_count: 1,
    currency_shadow_disagreement_count: 2
  };
  const service = createTechnicalStatsService({
    pool: {
      async query(sql) {
        const text = String(sql);
        if (text.includes("information_schema.columns")) return { rows: [{ exists: false }] };
        if (text.includes("AS local_fast_path_count")) return { rows: [eventRow] };
        return { rows: [{}] };
      }
    },
    now: () => new Date("2026-07-10T10:00:00Z")
  });

  const stats = await service.getTechnicalStats();
  assert.deepEqual({
    candidates: stats.today.localCandidateCount,
    accepted: stats.today.localAcceptedCount,
    primary: stats.today.localPrimaryCount,
    safe: stats.today.localSafeCount,
    reviewable: stats.today.localReviewableCount,
    rejected: stats.today.localRejectedCount,
    fallback: stats.today.llmFallbackCount
  }, { candidates: 12, accepted: 10, primary: 4, safe: 7, reviewable: 3, rejected: 2, fallback: 5 });
  assert.equal(stats.today.avgLocalParseSeconds, 0.002);
  assert.equal(stats.today.p95LocalParseSeconds, 0.004);
  assert.equal(stats.today.avgLlmHttpSeconds, 0.1);
  assert.equal(stats.today.p95LlmHttpSeconds, 0.22);
  assert.equal(stats.today.criticalShadowDisagreementRate, 1.7);
  assert.equal(stats.today.categoryOnlyShadowDisagreementRate, 2.5);
  assert.equal(stats.today.amountShadowDisagreementRate, 0.8);
  assert.equal(stats.today.currencyShadowDisagreementRate, 1.7);

  const text = formatTechnicalStats(stats);
  assert.match(text, /Local acceptance: 12 candidates \/ 10 accepted \/ 4 primary/);
  assert.match(text, /Levels: safe 7 \/ reviewable 3 \/ rejected 2/);
  assert.match(text, /LLM fallback: 5/);
  assert.match(text, /Internal latency avg\/P95: local 0\.002s\/0\.004s \/ LLM HTTP 0\.100s\/0\.220s/);
  assert.match(text, /Critical shadow: 2\/120 \(1\.7%\)/);
  assert.match(text, /Category-only shadow: 3\/120 \(2\.5%\)/);
  assert.match(text, /Amount\/currency shadow: 1\/120 \(0\.8%\) \/ 2\/120 \(1\.7%\)/);
});

test("technical formatter labels shadow rates insufficient below one hundred comparisons", () => {
  const period = {
    activeUsers: 0, newUsers: 0, messagesTotal: 0, textMessages: 0, voiceMessages: 0,
    photoMessages: 0, expensesSaved: 0, draftsCreated: 0, draftsConfirmed: 0,
    draftsCancelled: 0, parseFailed: 0, transcriptionFailed: 0, confirmRate: null,
    parseFailedRate: null, avgTextStageSeconds: {}, avgVoiceStageSeconds: {},
    p95TextStageSeconds: {}, p95VoiceStageSeconds: {}, localFastPathRejectReasons: {},
    shadowDisagreementFields: {}, shadowComparedCount: 99,
    criticalShadowDisagreementCount: 1, categoryOnlyShadowDisagreementCount: 1,
    amountShadowDisagreementCount: 1, currencyShadowDisagreementCount: 1
  };
  const text = formatTechnicalStats({ today: period, last7Days: period });
  assert.match(text, /Critical shadow: 1\/99 \(insufficient sample\)/);
  assert.match(text, /Category-only shadow: 1\/99 \(insufficient sample\)/);
});
