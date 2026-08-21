import assert from "node:assert/strict";
import test from "node:test";

import { classifyExpenseEvidenceDuplicate } from "../src/expenseEvidenceDedupe.js";

const candidate = { amount: 1840, currency: "THB", spentOn: "2026-08-18", spentAt: "12:10", merchant: "big c" };

test("does not classify same amount, currency and date alone as likely duplicate", () => {
  const result = classifyExpenseEvidenceDuplicate(candidate, [{ amount: 1840, currency: "THB", spentOn: "2026-08-18", merchant: "different shop" }]);

  assert.deepEqual(result, { classification: "possible_duplicate", reasonCode: "amount_currency_date" });
});

test("uses multiple financial signals across unresolved drafts and imports", () => {
  const result = classifyExpenseEvidenceDuplicate(candidate, [
    { amount: 1840, currency: "THB", spentOn: "2026-08-18", spentAt: "12:08", merchant: "Big C Extra", source: "unresolved_draft" },
    { amount: 1840, currency: "THB", spentOn: "2026-08-18", spentAt: "12:10", merchant: "big c", source: "unfinished_import" }
  ]);

  assert.deepEqual(result, { classification: "likely_duplicate", reasonCode: "amount_currency_date_merchant" });
});

test("keeps unrelated same-day payments new", () => {
  const result = classifyExpenseEvidenceDuplicate(candidate, [{ amount: 1810, currency: "THB", spentOn: "2026-08-18", merchant: "Big C" }]);

  assert.deepEqual(result, { classification: "new", reasonCode: null });
});
