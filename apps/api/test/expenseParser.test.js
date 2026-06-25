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

test("OpenAI parser accepts budget impact for large one-off expenses", async () => {
  const parser = createExpenseParser({
    apiKey: "test-key",
    now: () => new Date("2026-06-01T10:00:00+07:00"),
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      const expenseSchema = body.text.format.schema.properties.expenses.items;
      assert.deepEqual(expenseSchema.properties.budget_impact.enum, ["regular", "planned", "large_oneoff"]);
      assert.ok(expenseSchema.required.includes("budget_impact"));

      return jsonResponse({
        output_text: JSON.stringify({
          expenses: [{
            amount: 2000,
            currency: "THB",
            description: "продукты",
            category_slug: "groceries",
            tags: [],
            spent_at: "2026-06-01T10:00:00.000+07:00",
            budget_impact: "large_oneoff",
            confidence: 0.9,
            needs_review: false
          }],
          notes: []
        })
      });
    }
  });

  const parsed = await parser.parse("крупная разовая покупка продукты 2000 бат");

  assert.equal(parsed.expenses[0].budget_impact, "large_oneoff");
  assert.deepEqual(parsed.notes, []);
});

test("OpenAI parser prompt describes planned and large one-off budget impact rules", async () => {
  const parser = createExpenseParser({
    apiKey: "test-key",
    now: () => new Date("2026-06-01T10:00:00+07:00"),
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      const prompt = body.input[0].content;
      assert.match(prompt, /planned/);
      assert.match(prompt, /large_oneoff/);
      assert.match(prompt, /плановая/);
      assert.match(prompt, /крупная/);
      assert.match(prompt, /America\/New_York/);

      return jsonResponse({
        output_text: JSON.stringify({
          expenses: [{
            amount: 2000,
            currency: "THB",
            description: "rent",
            category_slug: "home",
            tags: [],
            spent_at: "2026-06-01T10:00:00.000+07:00",
            budget_impact: "planned",
            confidence: 0.9,
            needs_review: false
          }],
          notes: []
        })
      });
    }
  });

  const parsed = await parser.parse("плановая аренда 2000 бат", { timeZone: "America/New_York" });

  assert.equal(parsed.expenses[0].budget_impact, "planned");
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

test("local parser uses supplied timezone", async () => {
  const parser = createExpenseParser({
    now: () => new Date("2026-06-01T03:30:00Z")
  });

  const parsed = await parser.parse("coffee 70", { timeZone: "America/New_York" });

  assert.equal(parsed.expenses[0].spent_at, "2026-05-31T23:30:00.000-04:00");
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
