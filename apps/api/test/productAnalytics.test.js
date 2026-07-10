import test from "node:test";
import assert from "node:assert/strict";

import {
  MEANINGFUL_ACTIVITY_EVENTS,
  SINGLETON_ONBOARDING_EVENTS,
  normalizeAcquisitionSource,
  normalizeReportMarker,
  reportDeliveryErrorType
} from "../src/productAnalytics.js";

test("normalizes bounded first-touch sources", () => {
  assert.equal(normalizeAcquisitionSource(" Friend_Alex "), "friend_alex");
  assert.equal(normalizeAcquisitionSource("expat-cm"), "expat-cm");
  assert.equal(normalizeAcquisitionSource("name with spaces"), "direct");
  assert.equal(normalizeAcquisitionSource("x".repeat(65)), "direct");
  assert.equal(normalizeAcquisitionSource(null), "direct");
});

test("publishes the canonical meaningful and singleton event sets", () => {
  assert.equal(MEANINGFUL_ACTIVITY_EVENTS.has("expense_saved"), true);
  assert.equal(MEANINGFUL_ACTIVITY_EVENTS.has("planned_expense_created"), true);
  assert.equal(MEANINGFUL_ACTIVITY_EVENTS.has("report_delivered"), false);
  assert.equal(MEANINGFUL_ACTIVITY_EVENTS.has("bot_started"), false);
  assert.deepEqual([...SINGLETON_ONBOARDING_EVENTS], [
    "onboarding_started",
    "currency_selected",
    "budget_set",
    "onboarding_completed"
  ]);
});

test("accepts only bounded report markers", () => {
  assert.deepEqual(normalizeReportMarker("weekly", "2026-W28"), {
    reportType: "weekly",
    reportKey: "2026-W28"
  });
  assert.deepEqual(normalizeReportMarker("monthly", "2026-07"), {
    reportType: "monthly",
    reportKey: "2026-07"
  });
  assert.equal(normalizeReportMarker("daily", "2026-07-10"), null);
  assert.equal(normalizeReportMarker("weekly", "<b>bad</b>"), null);
});

test("classifies report errors without returning Telegram text", () => {
  assert.equal(reportDeliveryErrorType({
    status: 403,
    message: "Forbidden: bot was blocked by the user"
  }), "blocked");
  assert.equal(reportDeliveryErrorType({ status: 429 }), "rate_limited");
  assert.equal(reportDeliveryErrorType({ status: 503 }), "telegram_5xx");
  assert.equal(reportDeliveryErrorType({ code: "ETIMEDOUT" }), "network");
  assert.equal(reportDeliveryErrorType(new Error("private detail")), "unknown");
});

test("does not infer blocked state from unrelated forbidden or missing-chat errors", () => {
  assert.equal(reportDeliveryErrorType({ status: 403, message: "Forbidden" }), "unknown");
  assert.equal(reportDeliveryErrorType({ status: 400, message: "Bad Request: chat not found" }), "unknown");
});
