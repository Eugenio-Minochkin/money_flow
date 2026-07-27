import test from "node:test";
import assert from "node:assert/strict";

import { renderAdminRichMessage } from "../src/adminRichMessage.js";
import { formatTechnicalStatsSections } from "../src/technicalStatsService.js";

test("product rich renderer keeps primary sections open and escapes dynamic values", () => {
  const html = renderAdminRichMessage([
    section("📊 Product stats", [richRow("Generated: ", "2026-07-27 10:00 UTC", "code")]),
    section("👥 User base", [richRow("Reachable now: ", "2", "bold")]),
    section("📅 Today", [richRow("Active users: ", "1", "bold", " / new users: 1")]),
    section("📅 Last 7 days", [richRow("Active users: ", "3", "bold")]),
    section("🧭 Sources", [richRow("source: ", "a<b>&:\"'", "code")])
  ], { reportType: "product" });

  assert.match(html, /<h1>📊 Product stats<\/h1>/);
  assert.match(html, /<footer>Generated: <code>2026-07-27 10:00 UTC<\/code><\/footer>/);
  assert.match(html, /<h2>👥 User base<\/h2>/);
  assert.match(html, /<h2>📅 Today<\/h2>/);
  assert.match(html, /<h2>📅 Last 7 days<\/h2>/);
  assert.match(html, /<details><summary>🧭 Sources<\/summary>/);
  assert.match(html, /<table bordered striped>/);
  assert.match(html, /a&lt;b&gt;&amp;:&quot;&#39;<\/code>/);
  assert.doesNotMatch(html, /<script>/);
});

test("technical rich renderer preserves code rows and separates periods", () => {
  const html = renderAdminRichMessage([
    section("🛠 Technical stats", [richRow("Generated: ", "2026-07-27 10:00 UTC", "code")]),
    section("📨 Today — Traffic", [richRow("Messages: ", "1", "bold")]),
    section("✅ Today — Confirm flow", [richRow("Confirm flow attempts: ", "1", "bold")]),
    section("🚫 Today — Rejects", [richRow("Rejects: ", "amount: 1, currency: 2", "code")]),
    section("📨 Last 7 days — Traffic", [richRow("Messages: ", "2", "bold")]),
    section("🧩 Last 7 days — Shadow fields", [richRow("Shadow fields: ", "category: food", "code")])
  ], { reportType: "technical" });

  assert.match(html, /<h2>Today<\/h2>/);
  assert.match(html, /<h3>📨 Traffic<\/h3>/);
  assert.match(html, /<details><summary>✅ Confirm flow<\/summary>/);
  assert.match(html, /<code>amount: 1, currency: 2<\/code>/);
  assert.match(html, /<hr\/>/);
  assert.match(html, /<h2>Last 7 days<\/h2>/);
  assert.match(html, /<details><summary>🧩 Shadow fields<\/summary>/);
});

test("rich renderer omits empty sections and keeps plain rows without splitting colons", () => {
  const html = renderAdminRichMessage([
    section("📊 Product stats", [richRow("Generated: ", "2026-07-27 10:00 UTC", "code")]),
    section("📅 Today", ["a:b:c"]),
    section("📬 Reports", [])
  ], { reportType: "product" });

  assert.match(html, /<td colspan="2">a:b:c<\/td>/);
  assert.doesNotMatch(html, /Reports/);
});

test("technical renderer keeps every diagnostic group distinct from current sections", () => {
  const html = renderAdminRichMessage(formatTechnicalStatsSections({
    generatedAt: new Date("2026-07-27T10:00:00Z"),
    today: technicalPeriod(),
    last7Days: technicalPeriod()
  }), { reportType: "technical" });

  for (const metric of [
    "Confirm flow", "Confirm outcomes", "Confirm P95",
    "Parser routing", "Local acceptance", "Levels", "LLM fallback", "Internal latency",
    "Review", "Critical shadow", "Category-only shadow", "Amount/currency shadow", "Rejects", "Shadow fields"
  ]) assert.match(html, new RegExp(metric));
  assert.match(html, /<details><summary>✅ Confirm flow<\/summary>/);
  assert.match(html, /<details><summary>🧠 Parser routing and averages<\/summary>/);
  assert.match(html, /<details><summary>🚫 Rejects<\/summary>/);
  assert.match(html, /<code>amount: 1, currency 2<\/code>/);
  assert.match(html, /<code>category: food cafe<\/code>/);
  assert.equal((html.match(/<h2>Today<\/h2>/g) ?? []).length, 1);
  assert.equal((html.match(/<h2>Last 7 days<\/h2>/g) ?? []).length, 1);
});

function section(heading, rows) { return { heading, rows }; }
function richRow(label, value, style, suffix = "") {
  return { segments: [{ text: label, style: "plain" }, { text: value, style }, { text: suffix, style: "plain" }] };
}

function technicalPeriod() {
  return {
    activeUsers: 1, newUsers: 1, messagesTotal: 3, textMessages: 2, voiceMessages: 1, photoMessages: 0,
    expensesSaved: 1, draftsCreated: 2, draftsConfirmed: 1, draftsCancelled: 0, parseFailed: 0, transcriptionFailed: 0,
    confirmRate: 0.5, parseFailedRate: 0,
    confirmFlow: {
      attempts: 2, success: 1, alreadySaved: 0, cancelled: 0, categoryRequired: 1, failed: 0,
      avgCallbackAckSeconds: 0.1, p95CallbackAckSeconds: 0.2, avgUserResultSeconds: 0.3, p95UserResultSeconds: 0.4,
      avgTotalSeconds: 0.5, p95TotalSeconds: 0.6, avgDbSaveSeconds: 0.1, p95DbSaveSeconds: 0.2,
      avgTelegramUpdateSeconds: 0.1, p95TelegramUpdateSeconds: 0.2
    },
    avgTextProcessingSeconds: 1, avgVoiceProcessingSeconds: 2, p95TextProcessingSeconds: 3, p95VoiceProcessingSeconds: 4,
    avgTextStageSeconds: {}, avgVoiceStageSeconds: {}, p95TextStageSeconds: {}, p95VoiceStageSeconds: {},
    localFastPathCount: 1, llmCount: 2, llmSkippedCount: 0, localPrimaryCount: 1, localRejectedFallbackCount: 1,
    llmPrimaryCount: 1, localExceptionFallbackCount: 0, rolloutExcludedCount: 0, nonExpenseGuardCount: 0,
    avgLocalFastPathProcessingSeconds: 0.1, avgLlmProcessingSeconds: 0.2, localCandidateCount: 2, localAcceptedCount: 1,
    localSafeCount: 1, localReviewableCount: 0, localRejectedCount: 1, llmFallbackCount: 1,
    avgLocalParseSeconds: 0.01, p95LocalParseSeconds: 0.02, avgLlmHttpSeconds: 0.3, p95LlmHttpSeconds: 0.4,
    categoryNeedsReviewCount: 1, shadowDisagreementCount: 2, shadowComparedCount: 120,
    criticalShadowDisagreementCount: 1, criticalShadowDisagreementRate: 0.8,
    categoryOnlyShadowDisagreementCount: 1, categoryOnlyShadowDisagreementRate: 0.8,
    amountShadowDisagreementCount: 1, amountShadowDisagreementRate: 0.8,
    currencyShadowDisagreementCount: 1, currencyShadowDisagreementRate: 0.8,
    localFastPathRejectReasons: { "amount: 1, currency": 2 }, shadowDisagreementFields: { "category: food": "cafe" }
  };
}
