import test from "node:test";
import assert from "node:assert/strict";

import { parseExpenseText } from "../src/parser.js";

test("parses a simple Russian text expense into a draft item", () => {
  const result = parseExpenseText("кофе 70 бат", {
    now: new Date("2026-06-01T10:00:00+07:00")
  });

  assert.equal(result.expenses.length, 1);
  assert.deepEqual(result.expenses[0], {
    amount: 70,
    currency: "THB",
    description: "кофе",
    category_slug: "food_cafe",
    tags: [],
    spent_at: "2026-06-01T10:00:00.000+07:00",
    confidence: 0.86,
    needs_review: false
  });
  assert.deepEqual(result.notes, []);
});

test("uses THB when currency is omitted", () => {
  const result = parseExpenseText("обед 180", {
    now: new Date("2026-06-01T12:30:00+07:00")
  });

  assert.equal(result.expenses[0].currency, "THB");
  assert.equal(result.expenses[0].amount, 180);
});
