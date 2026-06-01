import test from "node:test";
import assert from "node:assert/strict";

import { createExpenseParser } from "../src/expenseParser.js";

test("uses OpenAI structured output when API key is configured", async () => {
  const parser = createExpenseParser({
    apiKey: "test-key",
    model: "gpt-test",
    now: () => new Date("2026-06-01T10:00:00+07:00"),
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      assert.equal(body.model, "gpt-test");
      assert.equal(body.text.format.type, "json_schema");

      return jsonResponse({
        output_text: JSON.stringify({
          expenses: [
            {
              amount: 70,
              currency: "THB",
              description: "кофе",
              category_slug: "food_cafe",
              tags: [],
              spent_at: "2026-06-01T10:00:00.000+07:00",
              confidence: 0.94,
              needs_review: false
            },
            {
              amount: 180,
              currency: "THB",
              description: "обед",
              category_slug: "food_cafe",
              tags: [],
              spent_at: "2026-06-01T12:00:00.000+07:00",
              confidence: 0.91,
              needs_review: false
            }
          ],
          notes: []
        })
      });
    }
  });

  const parsed = await parser.parse("кофе 70 бат и обед 180");

  assert.equal(parsed.expenses.length, 2);
  assert.equal(parsed.expenses[0].description, "кофе");
  assert.equal(parsed.expenses[1].amount, 180);
});

test("falls back to the local parser when OpenAI is not configured", async () => {
  const parser = createExpenseParser({
    now: () => new Date("2026-06-01T10:00:00+07:00")
  });

  const parsed = await parser.parse("кофе 70 бат");

  assert.equal(parsed.expenses.length, 1);
  assert.equal(parsed.expenses[0].amount, 70);
  assert.equal(parsed.expenses[0].description, "кофе");
});

test("falls back to the local parser when OpenAI fails", async () => {
  const originalError = console.error;
  console.error = () => {};
  const parser = createExpenseParser({
    apiKey: "test-key",
    now: () => new Date("2026-06-01T10:00:00+07:00"),
    fetchImpl: async () => jsonResponse({ error: "bad" }, { ok: false, status: 500 })
  });

  try {
    const parsed = await parser.parse("кофе 70 бат");

    assert.equal(parsed.expenses.length, 1);
    assert.equal(parsed.expenses[0].amount, 70);
    assert.equal(parsed.notes.at(-1), "AI parser unavailable, used local parser.");
  } finally {
    console.error = originalError;
  }
});

function jsonResponse(body, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    }
  };
}
