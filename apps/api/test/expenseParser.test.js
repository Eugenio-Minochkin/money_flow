import test from "node:test";
import assert from "node:assert/strict";

import { createExpenseParser, evaluateLocalFastPath, rolloutBucket } from "../src/expenseParser.js";
import { parseExpenseText } from "../../../packages/shared/src/parser.js";
import {
  SYNTHETIC_EXPENSE_PARSER_CORPUS,
  SYNTHETIC_HIGH_RISK_EXPENSES,
  SYNTHETIC_HIGH_RISK_FALSE_POSITIVES
} from "../../../packages/shared/testFixtures/expense-parser-regression-corpus.js";

test("synthetic corpus maps local rejects to diagnostic trace reasons", () => {
  for (const fixture of SYNTHETIC_EXPENSE_PARSER_CORPUS.filter((item) => item.route === "local_rejected")) {
    const localResult = parseExpenseText(fixture.text, { defaultCurrency: fixture.defaultCurrency ?? "THB" });
    const evaluation = evaluateLocalFastPath({ text: fixture.text, localResult });

    assert.equal(evaluation.localAcceptanceLevel, "local_rejected", fixture.id);
    assert.equal(evaluation.rejectReason, fixture.rejectReason, fixture.id);
  }
});

test("synthetic corpus routes safe and reviewable results explicitly inside rollout", async () => {
  for (const fixture of SYNTHETIC_EXPENSE_PARSER_CORPUS.filter((item) => item.route !== "local_rejected")) {
    let openAiCalls = 0;
    let trace;
    const parser = createExpenseParser({
      apiKey: "test-key",
      fastPathMode: "enabled",
      localFirstRolloutPercent: 100,
      parserTextHashSecret: "test-secret",
      now: () => new Date("2026-07-21T10:00:00+03:00"),
      fetchImpl: async () => {
        openAiCalls += 1;
        throw new Error("OpenAI must not be called for accepted local corpus entries");
      }
    });

    const result = await parser.parse(fixture.text, {
      defaultCurrency: fixture.defaultCurrency ?? "THB",
      userId: 42,
      onLlmTrace(metadata) { trace = metadata; }
    });

    assert.equal(openAiCalls, 0, fixture.id);
    assert.equal(result.expenses.length, fixture.count ?? 1, fixture.id);
    assert.equal(trace.localAcceptanceLevel, fixture.route, fixture.id);
    assert.equal(trace.parserRoute, "local_primary", fixture.id);
  }
});

test("synthetic high-risk intents never become local primary", async () => {
  for (const text of SYNTHETIC_HIGH_RISK_EXPENSES) {
    let openAiCalls = 0;
    let trace;
    const parser = createExpenseParser({
      apiKey: "test-key",
      fastPathMode: "enabled",
      localFirstRolloutPercent: 100,
      parserTextHashSecret: "test-secret",
      now: () => new Date("2026-07-21T10:00:00+03:00"),
      fetchImpl: async () => {
        openAiCalls += 1;
        return jsonResponse({ output_text: JSON.stringify({ expenses: [], notes: ["controlled reject"] }) });
      }
    });

    await parser.parse(text, { userId: 42, onLlmTrace(metadata) { trace = metadata; } });

    assert.equal(openAiCalls, 1, text);
    assert.equal(trace.localAcceptanceLevel, "local_rejected", text);
    assert.notEqual(trace.parserRoute, "local_primary", text);
  }
});

test("every synthetic high-risk intent becomes a controlled reject when LLM fallback fails", async () => {
  for (const text of SYNTHETIC_HIGH_RISK_EXPENSES) {
    let trace;
    const parser = createExpenseParser({
      apiKey: "test-key",
      fastPathMode: "enabled",
      localFirstRolloutPercent: 100,
      parserTextHashSecret: "test-secret",
      fetchImpl: async () => jsonResponse({ error: "unavailable" }, { ok: false, status: 503 })
    });

    await assert.rejects(
      () => parser.parse(text, { userId: 42, onLlmTrace(metadata) { trace = metadata; } }),
      /OpenAI Responses API failed/,
      text
    );

    assert.equal(trace.localAcceptanceLevel, "local_rejected", text);
    assert.equal(trace.parserRoute, "llm_error", text);
    assert.equal(trace.fallbackReason, "llm_error", text);
  }
});

test("nearby high-risk words in ordinary expenses do not block local primary", async () => {
  for (const text of SYNTHETIC_HIGH_RISK_FALSE_POSITIVES) {
    let trace;
    const parser = createExpenseParser({
      apiKey: "test-key",
      fastPathMode: "enabled",
      localFirstRolloutPercent: 100,
      parserTextHashSecret: "test-secret",
      fetchImpl: async () => {
        throw new Error("OpenAI must not be called for a safe lexical neighbor");
      }
    });

    const result = await parser.parse(text, { userId: 42, onLlmTrace(metadata) { trace = metadata; } });

    assert.equal(result.expenses.length, 1, text);
    assert.match(trace.localAcceptanceLevel, /^local_(safe|reviewable)$/, text);
    assert.equal(trace.parserRoute, "local_primary", text);
  }
});

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
  assert.equal(trace.parserRoute, "local_no_api_key");
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
  let localCalls = 0;
  let trace;
  const parser = createExpenseParser({
    apiKey: "test-key",
    fastPathMode: "off",
    localParser: () => {
      localCalls += 1;
      throw new Error("local parser must not run in off mode");
    },
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
  assert.equal(localCalls, 0);
  assert.equal(parsed.expenses[0].amount, 80);
  assert.equal(trace.parserEngine, "llm");
  assert.equal("localFastPathAccepted" in trace, false);
  assert.equal("localAcceptanceLevel" in trace, false);
  assert.equal("localCandidate" in trace, false);
  assert.equal("localParseMs" in trace, false);
  assert.equal("localEvaluateMs" in trace, false);
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

test("enabled fast-path allowlist uses Telegram user id", async () => {
  let openAiCalls = 0;
  let trace;
  const parser = createExpenseParser({
    apiKey: "test-key",
    fastPathMode: "enabled",
    localFirstRolloutPercent: 0,
    localFirstUserIds: ["100001"],
    parserTextHashSecret: "test-secret",
    now: () => new Date("2026-06-01T10:00:00+07:00"),
    fetchImpl: async () => {
      openAiCalls += 1;
      throw new Error("OpenAI should not be called");
    }
  });

  const parsed = await parser.parse("coffee 80", {
    userId: 100001,
    onLlmTrace(metadata) {
      trace = metadata;
    }
  });

  assert.equal(openAiCalls, 0);
  assert.equal(parsed.expenses[0].amount, 80);
  assert.equal(trace.parserRoute, "local_primary");
});

test("rollout bucket is deterministic for the same user and secret", () => {
  const buckets = Array.from({ length: 1000 }, () => rolloutBucket("42", "test-secret"));

  assert.equal(new Set(buckets).size, 1);
  assert.equal(buckets[0] >= 0 && buckets[0] < 100, true);
  assert.notEqual(rolloutBucket("42", "other-secret"), buckets[0]);
});

test("fractional rollout percent is floored to an integer", async () => {
  let openAiCalls = 0;
  const parser = createExpenseParser({
    apiKey: "test-key",
    fastPathMode: "enabled",
    localFirstRolloutPercent: 100.9,
    parserTextHashSecret: "test-secret",
    now: () => new Date("2026-06-01T10:00:00+07:00"),
    fetchImpl: async () => {
      openAiCalls += 1;
      throw new Error("OpenAI should not be called");
    }
  });

  await parser.parse("coffee 80", { userId: 42 });

  assert.equal(openAiCalls, 0);
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

test("local acceptance classifies safe reviewable and rejected candidates without changing compatibility flags", () => {
  const baseExpense = {
    amount: 80,
    currency: "THB",
    spent_at: "2026-06-01T10:00:00+07:00",
    category_slug: "food_cafe",
    needs_review: false
  };

  const safe = evaluateLocalFastPath({ text: "coffee 80", localResult: { expenses: [baseExpense] } });
  const reviewable = evaluateLocalFastPath({
    text: "notebook 80",
    localResult: { expenses: [{ ...baseExpense, category_slug: "other", needs_review: true }] }
  });
  const rejected = evaluateLocalFastPath({ text: "split taxi 80", localResult: { expenses: [baseExpense] } });

  assert.equal(safe.localAcceptanceLevel, "local_safe");
  assert.equal(safe.accepted, true);
  assert.equal(reviewable.localAcceptanceLevel, "local_reviewable");
  assert.equal(reviewable.accepted, true);
  assert.equal(rejected.localAcceptanceLevel, "local_rejected");
  assert.equal(rejected.accepted, false);
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

test("unsupported transfer topup and planned intents reject local fast-path", async () => {
  const examples = [
    "переведи 1000",
    "пополнение бюджета 500",
    "запланируй оплату 1000",
    "положил в бюджет 500"
  ];

  for (const text of examples) {
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
            expenses: [],
            notes: ["unsupported local intent"]
          })
        });
      }
    });

    await parser.parse(text, {
      userId: 42,
      onLlmTrace(metadata) {
        trace = metadata;
      }
    });

    assert.equal(openAiCalls, 1, text);
    assert.equal(trace.parserRoute, "local_rejected_fallback", text);
    assert.equal(trace.localFastPathAccepted, false, text);
    assert.equal(trace.localFastPathRejectReason, "unsupported_intent", text);
  }
});

test("unsupported-intent stop patterns avoid broad false positives", async () => {
  const examples = [
    "оплатил интернет 600",
    "пополнение телефона 100"
  ];

  for (const text of examples) {
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

    const parsed = await parser.parse(text, {
      userId: 42,
      onLlmTrace(metadata) {
        trace = metadata;
      }
    });

    assert.equal(openAiCalls, 0, text);
    assert.equal(parsed.expenses.length, 1, text);
    assert.equal(trace.parserRoute, "local_primary", text);
  }
});

test("bare budget phrase does not reject ordinary expense wording", async () => {
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

  const parsed = await parser.parse("уложился в бюджет обед 300", {
    userId: 42,
    onLlmTrace(metadata) {
      trace = metadata;
    }
  });

  assert.equal(openAiCalls, 0);
  assert.equal(parsed.expenses[0].amount, 300);
  assert.equal(trace.parserRoute, "local_primary");
});

test("English unsupported intents reject local fast-path", async () => {
  const examples = [
    "transfer 1000",
    "send 1000",
    "send money 1000",
    "top up the budget 500",
    "budget top up 500",
    "put 500 into budget",
    "set aside 500",
    "reserve 500",
    "plan a payment 1000",
    "planned payment 1000",
    "airport transfer 500 baht"
  ];

  for (const text of examples) {
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
            expenses: [],
            notes: ["unsupported local intent"]
          })
        });
      }
    });

    await parser.parse(text, {
      userId: 42,
      onLlmTrace(metadata) {
        trace = metadata;
      }
    });

    assert.equal(openAiCalls, 1, text);
    assert.equal(trace.parserRoute, "local_rejected_fallback", text);
    assert.equal(trace.localFastPathRejectReason, "unsupported_intent", text);
  }
});

test("English unsupported-intent stop patterns avoid broad false positives", async () => {
  const examples = [
    "paid internet 600",
    "paid for internet 600",
    "phone top up 100"
  ];

  for (const text of examples) {
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

    const parsed = await parser.parse(text, {
      userId: 42,
      onLlmTrace(metadata) {
        trace = metadata;
      }
    });

    assert.equal(openAiCalls, 0, text);
    assert.equal(parsed.expenses.length, 1, text);
    assert.equal(trace.parserRoute, "local_primary", text);
  }
});

test("enabled allowlist accepts safe Russian amount words locally", async () => {
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

  const parsed = await parser.parse("молоко сто бат", {
    userId: 42,
    onLlmTrace(metadata) {
      trace = metadata;
    }
  });

  assert.equal(openAiCalls, 0);
  assert.equal(parsed.expenses[0].amount, 100);
  assert.equal(trace.parserEngine, "local-fast-path");
  assert.equal(trace.parserRoute, "local_primary");
  assert.equal(trace.llmSkipped, true);
});

test("Russian amount words still respect split semantics safety", async () => {
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
            description: "такси",
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

  await parser.parse("такси сто двадцать пополам с другом", {
    userId: 42,
    onLlmTrace(metadata) {
      trace = metadata;
    }
  });

  assert.equal(openAiCalls, 1);
  assert.equal(trace.parserRoute, "local_rejected_fallback");
  assert.equal(trace.localFastPathRejectReason, "split_semantics");
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

test("shadow comparison treats category and needs review as reviewable on the same timezone-aware local day", async () => {
  let trace;
  const parser = createExpenseParser({
    apiKey: "test-key",
    fastPathMode: "shadow",
    now: () => new Date("2026-06-01T12:00:00Z"),
    localParser: () => ({
      expenses: [{
        amount: 80,
        currency: "THB",
        description: "coffee",
        category_slug: "food_cafe",
        tags: [],
        spent_at: "2026-06-01T23:30:00+07:00",
        budget_impact: "regular",
        confidence: 0.9,
        needs_review: false
      }],
      notes: []
    }),
    fetchImpl: async () => jsonResponse({
      output_text: JSON.stringify({
        expenses: [{
          amount: 80,
          currency: "THB",
          description: "coffee",
          category_slug: "other",
          tags: [],
          spent_at: "2026-06-01T16:30:00Z",
          budget_impact: "regular",
          confidence: 0.6,
          needs_review: true
        }],
        notes: []
      })
    })
  });

  await parser.parse("coffee 80", {
    timeZone: "Asia/Bangkok",
    onLlmTrace(metadata) { trace = metadata; }
  });

  assert.deepEqual(trace.shadowDisagreementFields, ["category_slug", "needs_review"]);
  assert.equal(trace.criticalShadowDisagreement, false);
  assert.equal(trace.categoryOnlyShadowDisagreement, true);
});

test("shadow comparison marks timezone local day and budget impact disagreements as critical", async () => {
  let trace;
  const parser = createExpenseParser({
    apiKey: "test-key",
    fastPathMode: "shadow",
    now: () => new Date("2026-06-01T12:00:00Z"),
    localParser: () => ({
      expenses: [{
        amount: 80,
        currency: "THB",
        description: "coffee",
        category_slug: "food_cafe",
        tags: [],
        spent_at: "2026-06-01T23:30:00+07:00",
        budget_impact: "regular",
        confidence: 0.9,
        needs_review: false
      }],
      notes: []
    }),
    fetchImpl: async () => jsonResponse({
      output_text: JSON.stringify({
        expenses: [{
          amount: 80,
          currency: "THB",
          description: "coffee",
          category_slug: "food_cafe",
          tags: [],
          spent_at: "2026-06-01T17:30:00Z",
          budget_impact: "large_oneoff",
          confidence: 0.9,
          needs_review: false
        }],
        notes: []
      })
    })
  });

  await parser.parse("coffee 80", {
    timeZone: "Asia/Bangkok",
    onLlmTrace(metadata) { trace = metadata; }
  });

  assert.deepEqual(trace.shadowDisagreementFields, ["spent_at", "budget_impact"]);
  assert.equal(trace.criticalShadowDisagreement, true);
  assert.equal(trace.categoryOnlyShadowDisagreement, false);
});

test("internal parser timing exposes local parse evaluation and total durations on local primary", async () => {
  let trace;
  const parser = createExpenseParser({
    apiKey: "test-key",
    fastPathMode: "enabled",
    localFirstRolloutPercent: 100,
    parserTextHashSecret: "test-secret",
    now: () => new Date("2026-06-01T10:00:00+07:00"),
    performanceNow: tickingClock(),
    fetchImpl: async () => { throw new Error("OpenAI should not be called"); }
  });

  await parser.parse("coffee 80", {
    userId: 42,
    onLlmTrace(metadata) { trace = metadata; }
  });

  for (const field of ["localParseMs", "localEvaluateMs", "parserTotalMs"]) {
    assert.equal(Number.isFinite(trace[field]), true, field);
    assert.equal(trace[field] >= 0, true, field);
  }
  assert.equal(trace.llmHttpMs, undefined);
  assert.equal(trace.llmDecodeNormalizeMs, undefined);
});

test("internal parser timing separates LLM HTTP from decode and normalization", async () => {
  let trace;
  const parser = createExpenseParser({
    apiKey: "test-key",
    fastPathMode: "shadow",
    now: () => new Date("2026-06-01T10:00:00+07:00"),
    performanceNow: tickingClock(),
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

  await parser.parse("coffee 80", {
    onLlmTrace(metadata) { trace = metadata; }
  });

  for (const field of ["localParseMs", "localEvaluateMs", "llmHttpMs", "llmDecodeNormalizeMs", "parserTotalMs"]) {
    assert.equal(Number.isFinite(trace[field]), true, field);
    assert.equal(trace[field] >= 0, true, field);
  }
});

test("OpenAI error returns accepted local result with explicit fallback route", async () => {
  const originalError = console.error;
  console.error = () => {};
  let trace;
  const parser = createExpenseParser({
    apiKey: "test-key",
    fastPathMode: "enabled",
    localFirstRolloutPercent: 0,
    parserTextHashSecret: "test-secret",
    now: () => new Date("2026-06-01T10:00:00+07:00"),
    fetchImpl: async () => jsonResponse({ error: "bad" }, { ok: false, status: 500 })
  });

  try {
    const parsed = await parser.parse("coffee 70", {
      userId: 7,
      onLlmTrace(metadata) {
        trace = metadata;
      }
    });

    assert.equal(parsed.expenses[0].amount, 70);
    assert.equal(trace.parserEngine, "local-fallback");
    assert.equal(trace.parserRoute, "llm_error_local_accepted_fallback");
    assert.equal(trace.fallbackReason, "llm_error");
  } finally {
    console.error = originalError;
  }
});

test("OpenAI error without accepted local result keeps parser failure path", async () => {
  let trace;
  const parser = createExpenseParser({
    apiKey: "test-key",
    fastPathMode: "enabled",
    localFirstRolloutPercent: 0,
    parserTextHashSecret: "test-secret",
    now: () => new Date("2026-06-01T10:00:00+07:00"),
    fetchImpl: async () => jsonResponse({ error: "bad" }, { ok: false, status: 500 })
  });

  await assert.rejects(
    () => parser.parse("I paid half of the taxi 120", {
      userId: 7,
      onLlmTrace(metadata) {
        trace = metadata;
      }
    }),
    /OpenAI Responses API failed/
  );

  assert.equal(trace.parserRoute, "llm_error");
  assert.equal(trace.fallbackReason, "llm_error");
});

test("LLM timeout aborts the request once and falls back only for local_safe", async () => {
  let trace;
  let calls = 0;
  let aborted = false;
  const parser = createExpenseParser({
    apiKey: "test-key",
    fastPathMode: "enabled",
    localFirstRolloutPercent: 0,
    parserTextHashSecret: "test-secret",
    llmTimeoutMs: 5,
    now: () => new Date("2026-06-01T10:00:00+07:00"),
    fetchImpl: async (_url, { signal }) => {
      calls += 1;
      assert.equal(signal instanceof AbortSignal, true);
      return await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          const error = new Error("request aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }
  });

  const parsed = await parser.parse("coffee 70", {
    userId: 7,
    onLlmTrace(metadata) {
      trace = metadata;
    }
  });

  assert.equal(parsed.expenses[0].amount, 70);
  assert.equal(calls, 1);
  assert.equal(aborted, true);
  assert.equal(trace.localAcceptanceLevel, "local_safe");
  assert.equal(trace.parserRoute, "llm_error_local_accepted_fallback");
  assert.equal(trace.fallbackReason, "expense_parser_llm_timeout");
});

test("LLM timeout rejects local_reviewable with a safe code and without retry", async () => {
  let trace;
  let calls = 0;
  let aborted = false;
  const parser = createExpenseParser({
    apiKey: "test-key",
    fastPathMode: "enabled",
    localFirstRolloutPercent: 0,
    parserTextHashSecret: "test-secret",
    llmTimeoutMs: 5,
    now: () => new Date("2026-06-01T10:00:00+07:00"),
    fetchImpl: async (_url, { signal }) => {
      calls += 1;
      return await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          const error = new Error("request aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }
  });

  await assert.rejects(
    () => parser.parse("notebook 80", {
      userId: 7,
      onLlmTrace(metadata) {
        trace = metadata;
      }
    }),
    (error) => error.code === "expense_parser_llm_timeout"
  );

  assert.equal(calls, 1);
  assert.equal(aborted, true);
  assert.equal(trace.localAcceptanceLevel, "local_reviewable");
  assert.equal(trace.parserRoute, "llm_error");
  assert.equal(trace.fallbackReason, "expense_parser_llm_timeout");
});

test("local parser exception falls back to LLM with explicit route", async () => {
  let trace;
  const parser = createExpenseParser({
    apiKey: "test-key",
    fastPathMode: "enabled",
    localFirstRolloutPercent: 100,
    parserTextHashSecret: "test-secret",
    localParser: () => {
      throw new TypeError("synthetic local parser failure with raw text hidden");
    },
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

  const parsed = await parser.parse("coffee 80", {
    userId: 42,
    onLlmTrace(metadata) {
      trace = metadata;
    }
  });

  assert.equal(parsed.expenses[0].amount, 80);
  assert.equal(trace.parserEngine, "llm");
  assert.equal(trace.parserRoute, "local_exception_fallback");
  assert.equal(trace.localFastPathRejectReason, "local_exception");
  assert.equal(trace.localParserErrorName, "TypeError");
  assert.equal("localParserErrorMessage" in trace, false);
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

function tickingClock() {
  let value = 0;
  return () => {
    value += 1;
    return value;
  };
}
