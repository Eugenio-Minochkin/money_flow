import assert from "node:assert/strict";
import test from "node:test";

import { classifySmartSaveDraft } from "../src/smartSave.js";

const now = new Date("2026-08-14T12:00:00.000Z");
const safeItem = {
  amount: 180,
  currency: "THB",
  description: "coffee",
  category_slug: "food_cafe",
  category_source: "parser",
  needs_review: false,
  spent_at: "2026-08-13T08:15:00.000Z",
  budget_impact: "regular"
};

test("Smart Save accepts one confident valid ordinary expense", () => {
  assert.deepEqual(classifySmartSaveDraft({ items: [safeItem] }, { now }), {
    eligible: true,
    reason: null
  });
});

test("Smart Save explains every review and validation rejection", () => {
  const cases = [
    [[], "no_items"],
    [[safeItem, safeItem], "multiple_items"],
    [[{ ...safeItem, needs_review: true }], "needs_review"],
    [[{ ...safeItem, category_slug: "other", category_source: "parser" }], "category_required"],
    [[{ ...safeItem, category_slug: "unknown" }], "invalid_category"],
    [[{ ...safeItem, amount: 0 }], "invalid_amount"],
    [[{ ...safeItem, currency: "BTC" }], "invalid_currency"],
    [[{ ...safeItem, spent_at: null }], "invalid_date"],
    [[{ ...safeItem, spent_at: "" }], "invalid_date"],
    [[{ ...safeItem, spent_at: "not-a-date" }], "invalid_date"],
    [[{ ...safeItem, spent_at: "2026-08-15T08:15:00.000Z" }], "future_date"],
    [[{ ...safeItem, budget_impact: "planned" }], "non_expense_operation"]
  ];

  for (const [items, reason] of cases) {
    assert.deepEqual(classifySmartSaveDraft({ items }, { now }), { eligible: false, reason });
  }
});

test("Smart Save accepts a user-chosen other category", () => {
  const result = classifySmartSaveDraft({
    items: [{ ...safeItem, category_slug: "other", category_source: "user" }]
  }, { now });

  assert.equal(result.eligible, true);
});

test("Smart Save keeps a draft from a closed historical month unresolved", () => {
  const result = classifySmartSaveDraft({ items: [safeItem] }, {
    now,
    timeZone: "Asia/Bangkok",
    closedMonthKeys: new Set(["2026-08"])
  });

  assert.deepEqual(result, { eligible: false, reason: "closed_month" });
});

test("Smart Save accepts large one-off expenses but not planned operations", () => {
  assert.equal(classifySmartSaveDraft({
    items: [{ ...safeItem, budget_impact: "large_oneoff" }]
  }, { now }).eligible, true);
});
