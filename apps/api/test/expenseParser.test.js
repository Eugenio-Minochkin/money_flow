import test from "node:test";
import assert from "node:assert/strict";

import { createExpenseParser, rolloutBucket } from "../src/expenseParser.js";

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
  let trace;
  const parser = createExpenseParser({
    now: () => new Date("2026-06-01T10:00:00+07:00")
  });

  const parsed = await parser.parse("кофе 70 бат", {
    onLlmTrace(metadata) {
      trace = metadata;
    }
  });

  assert.equal(parsed.expenses.length, 1);
  assert.equal(parsed.expenses[0].amount, 70);
  assert.equal(parsed.expenses[0].description, "кофе");
  assert.equal(trace.parserEngine, "local-fallback");
  assert.equal(trace.llmSkipped, true);
});

test("local parser uses supplied timezone", async () => {
  const parser = createExpenseParser({
    now: () => new Date("2026-06-01T03:30:00Z")
  });

  const parsed = await parser.parse("coffee 70", { timeZone: "America/New_York" });

  assert.equal(parsed.expenses[0].spent_at, "2026-05-31T23:30:00.000-04:00");
});

test("off mode calls OpenAI before local parser", async () => {
  let openAiCalls = 0;
  let trace;
  const parser = createExpenseParser({
    apiKey: "test-key",
    fastPathMode: "off",
    now: () => new Date("2026-06-01T10:00:00+07:00"),
    fetchImpl: async () => {
      openAiCalls += 1;
      return jsonResponse({
        output_text: JSON.stringify({
          expenses: [{
            amount: 80,
            currency: "THB",
            description: "coffee",
            category_slug: "food_cafe",
            tags: [],
            spent_at: "2026-06-01T10:00:00.000+07:00",
            budget_impact: "regular",
            confidence: 0.9,
            needs_review: false
          }],
          notes: []
        })
      });
    }
  });

  const parsed = await parser.parse("coffee 80", {
    userId: 42,
    onLlmTrace(metadata) {
      trace = metadata;
    }
  });

  assert.equal(openAiCalls, 1);
  assert.equal(parsed.expenses[0].amount, 80);
  assert.equal(trace.parserEngine, "llm");
  assert.equal(trace.localFastPathAccepted, false);
  assert.equal(trace.fastPathMode, "off");
});

test("enabled fast-path skips OpenAI for simple English expense", async () => {
  let openAiCalls = 0;
  let trace;
  const parser = createExpenseParser({
    apiKey: "test-key",
    fastPathMode: "enabled",
    localFirstRolloutPercent: 100,
    parserTextHashSecret: "test-secret",
    now: () => new Date("2026-06-01T10:00:00+07:00"),
    fetchImpl: async () => {
      openAiCalls += 1;
      throw new Error("OpenAI should not be called");
    }
  });

  const parsed = await parser.parse("coffee 80", {
    userId: 42,
    onLlmTrace(metadata) {
      trace = metadata;
    }
  });

  assert.equal(openAiCalls, 0);
  assert.equal(parsed.expenses[0].category_slug, "food_cafe");
  assert.equal(parsed.expenses[0].needs_review, false);
  assert.equal(trace.parserEngine, "local-fast-path");
  assert.equal(trace.localFastPathAccepted, true);
  assert.equal(trace.llmSkipped, true);
  assert.equal(trace.fastPathMode, "enabled");
});

test("enabled fast-path outside rollout behaves as shadow", async () => {
  let openAiCalls = 0;
  let trace;
  const parser = createExpenseParser({
    apiKey: "test-key",
    fastPathMode: "enabled",
    localFirstRolloutPercent: 0,
    localFirstUserIds: ["42"],
    parserTextHashSecret: "test-secret",
    now: () => new Date("2026-06-01T10:00:00+07:00"),
    fetchImpl: async () => {
      openAiCalls += 1;
      return jsonResponse({
        output_text: JSON.stringify({
          expenses: [{
            amount: 90,
            currency: "THB",
            description: "coffee",
            category_slug: "food_cafe",
            tags: [],
            spent_at: "2026-06-01T10:00:00.000+07:00",
            budget_impact: "regular",
            confidence: 0.9,
            needs_review: false
          }],
          notes: []
        })
      });
    }
  });

  const parsed = await parser.parse("coffee 80", {
    userId: 7,
    onLlmTrace(metadata) {
      trace = metadata;
    }
  });

  assert.equal(openAiCalls, 1);
  assert.equal(parsed.expenses[0].amount, 90);
  assert.equal(trace.parserEngine, "llm");
  assert.equal(trace.parserRoute, "rollout_excluded");
  assert.equal(trace.localFastPathAccepted, true);
  assert.equal(trace.shadowDisagreement, true);
  assert.deepEqual(trace.shadowDisagreementFields, ["amount"]);
});

test("enabled fast-path allowlist overrides zero percent rollout", async () => {
  let openAiCalls = 0;
  let trace;
  const parser = createExpenseParser({
    apiKey: "test-key",
    fastPathMode: "enabled",
    localFirstRolloutPercent: 0,
    localFirstUserIds: ["42"],
    parserTextHashSecret: "test-secret",
    now: () => new Date("2026-06-01T10:00:00+07:00"),
    fetchImpl: async () => {
      openAiCalls += 1;
      throw new Error("OpenAI should not be called");
    }
  });

  const parsed = await parser.parse("coffee 80", {
    userId: 42,
    onLlmTrace(metadata) {
      trace = metadata;
    }
  });

  assert.equal(openAiCalls, 0);
  assert.equal(parsed.expenses[0].amount, 80);
  assert.equal(trace.parserRoute, "local_primary");
  assert.equal(trace.llmSkipped, true);
});

test("rollout bucket is deterministic for the same user and secret", () => {
  const buckets = Array.from({ length: 1000 }, () => rolloutBucket("42", "test-secret"));

  assert.equal(new Set(buckets).size, 1);
  assert.equal(buckets[0] >= 0 && buckets[0] < 100, true);
  assert.notEqual(rolloutBucket("42", "other-secret"), buckets[0]);
});

test("enabled fast-path keeps unknown category as review without OpenAI", async () => {
  let openAiCalls = 0;
  let trace;
  const parser = createExpenseParser({
    apiKey: "test-key",
    fastPathMode: "enabled",
    localFirstRolloutPercent: 100,
    parserTextHashSecret: "test-secret",
    now: () => new Date("2026-06-01T10:00:00+07:00"),
    fetchImpl: async () => {
      openAiCalls += 1;
      throw new Error("OpenAI should not be called");
    }
  });

  const parsed = await parser.parse("notebook 120", {
    userId: 42,
    onLlmTrace(metadata) {
      trace = metadata;
    }
  });

  assert.equal(openAiCalls, 0);
  assert.equal(parsed.expenses[0].category_slug, "other");
  assert.equal(parsed.expenses[0].needs_review, true);
  assert.equal(trace.categoryResolution, "needs_user_review");
});

test("stop-patterns reject local fast-path and call OpenAI", async () => {
  let openAiCalls = 0;
  let trace;
  const parser = createExpenseParser({
    apiKey: "test-key",
    fastPathMode: "enabled",
    localFirstRolloutPercent: 100,
    parserTextHashSecret: "test-secret",
    now: () => new Date("2026-06-01T10:00:00+07:00"),
    fetchImpl: async () => {
      openAiCalls += 1;
      return jsonResponse({
        output_text: JSON.stringify({
          expenses: [{
            amount: 120,
            currency: "THB",
            description: "taxi",
            category_slug: "transport",
            tags: [],
            spent_at: "2026-06-01T10:00:00.000+07:00",
            budget_impact: "regular",
            confidence: 0.9,
            needs_review: false
          }],
          notes: []
        })
      });
    }
  });

  const parsed = await parser.parse("I paid half of the taxi 120", {
    userId: 42,
    onLlmTrace(metadata) {
      trace = metadata;
    }
  });

  assert.equal(openAiCalls, 1);
  assert.equal(parsed.expenses[0].description, "taxi");
  assert.equal(trace.parserEngine, "llm");
  assert.equal(trace.localFastPathAccepted, false);
  assert.equal(trace.localFastPathRejectReason, "split_semantics");
  assert.equal(trace.llmSkipped, false);
});

test("shadow mode calls OpenAI and applies LLM result while recording disagreement", async () => {
  let openAiCalls = 0;
  let trace;
  const parser = createExpenseParser({
    apiKey: "test-key",
    fastPathMode: "shadow",
    now: () => new Date("2026-06-01T10:00:00+07:00"),
    fetchImpl: async () => {
      openAiCalls += 1;
      return jsonResponse({
        output_text: JSON.stringify({
          expenses: [{
            amount: 90,
            currency: "THB",
            description: "coffee",
            category_slug: "food_cafe",
            tags: [],
            spent_at: "2026-06-01T10:00:00.000+07:00",
            budget_impact: "regular",
            confidence: 0.9,
            needs_review: false
          }],
          notes: []
        })
      });
    }
  });

  const parsed = await parser.parse("coffee 80", {
    onLlmTrace(metadata) {
      trace = metadata;
    }
  });

  assert.equal(openAiCalls, 1);
  assert.equal(parsed.expenses[0].amount, 90);
  assert.equal(trace.parserEngine, "llm");
  assert.equal(trace.fastPathMode, "shadow");
  assert.equal(trace.localFastPathAccepted, true);
  assert.equal(trace.shadowDisagreement, true);
  assert.deepEqual(trace.shadowDisagreementFields, ["amount"]);
});

test("OpenAI errors keep the existing parser failure path instead of local fallback", async () => {
  const originalError = console.error;
  console.error = () => {};
  const parser = createExpenseParser({
    apiKey: "test-key",
    fastPathMode: "enabled",
    localFirstRolloutPercent: 0,
    parserTextHashSecret: "test-secret",
    now: () => new Date("2026-06-01T10:00:00+07:00"),
    fetchImpl: async () => jsonResponse({ error: "bad" }, { ok: false, status: 500 })
  });

  try {
    await assert.rejects(
      () => parser.parse("coffee 70", { userId: 7 }),
      /OpenAI Responses API failed/
    );
  } finally {
    console.error = originalError;
  }
});

test("parsed expenses carry category_source parser", async () => {
  const parser = createExpenseParser({
    apiKey: "test-key",
    now: () => new Date("2026-06-01T10:00:00+07:00"),
    fetchImpl: async () => jsonResponse({
      output_text: JSON.stringify({
        expenses: [{
          amount: 80,
          currency: "THB",
          description: "coffee",
          category_slug: "food_cafe",
          tags: [],
          spent_at: "2026-06-01T10:00:00.000+07:00",
          budget_impact: "regular",
          confidence: 0.9,
          needs_review: false
        }],
        notes: []
      })
    })
  });

  const result = await parser.parse("coffee 80", { defaultCurrency: "THB", timeZone: "Asia/Bangkok" });

  assert.equal(result.expenses[0].category_source, "parser");
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
