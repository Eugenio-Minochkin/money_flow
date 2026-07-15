import test from "node:test";
import assert from "node:assert/strict";

import {
  parseAmountInput,
  parseDescriptionInput,
  parseEditorText,
  parseSpentAtInput,
  parseTagsInput
} from "../src/telegramExpenseInput.js";

function hasCode(code) {
  return (error) => error?.code === code;
}

test("parses a strict positive amount with an optional supported currency", () => {
  assert.deepEqual(parseAmountInput("120", { currentCurrency: "THB" }), { amount: 120, currency: "THB" });
  assert.deepEqual(parseAmountInput("15 USD", { currentCurrency: "THB" }), { amount: 15, currency: "USD" });
  assert.throws(() => parseAmountInput("NaN"), hasCode("expense_invalid_amount"));
  assert.throws(() => parseAmountInput("0"), hasCode("expense_invalid_amount"));
  assert.throws(() => parseAmountInput("120 BTC"), hasCode("expense_invalid_currency"));
});

test("normalizes description and tags without accepting invalid values", () => {
  assert.equal(parseDescriptionInput("  coffee with milk  "), "coffee with milk");
  assert.throws(() => parseDescriptionInput("   "), hasCode("expense_invalid_description"));
  assert.deepEqual(parseTagsInput(" work, travel, work "), ["work", "travel"]);
  assert.deepEqual(parseTagsInput("-"), []);
  assert.throws(() => parseTagsInput("x".repeat(65)), hasCode("expense_invalid_tags"));
});

test("resolves yearless dates to the nearest previous local calendar occurrence", () => {
  const now = new Date("2026-07-15T12:00:00.000Z"); // 19:00 Bangkok
  const options = { now, timeZone: "Asia/Bangkok", language: "ru" };

  assert.equal(parseSpentAtInput("12 июля 19:30", options).toISOString(), "2026-07-12T12:30:00.000Z");
  assert.equal(parseSpentAtInput("20 июля 19:30", options).toISOString(), "2025-07-20T12:30:00.000Z");
  assert.throws(() => parseSpentAtInput("15 июля 20:00", options), hasCode("expense_future_date"));
});

test("validates explicit RU and EN dates in the user timezone", () => {
  const now = new Date("2026-07-15T12:00:00.000Z");
  const options = { now, timeZone: "Asia/Bangkok", language: "en" };

  assert.equal(parseSpentAtInput("Jul 12 2026 19:30", options).toISOString(), "2026-07-12T12:30:00.000Z");
  assert.throws(() => parseSpentAtInput("Jul 16 2026 10:00", options), hasCode("expense_future_date"));
  assert.throws(() => parseSpentAtInput("29 февраля 2026 10:00", options), hasCode("expense_invalid_date"));
  assert.deepEqual(
    parseEditorText("tags", "one, two", options),
    ["one", "two"]
  );
});
