import test from "node:test";
import assert from "node:assert/strict";

import { CATEGORIES } from "../../../packages/shared/src/categories.js";
import { EXPENSE_PARSER_BENCHMARK_CORPUS } from "../../../packages/shared/testFixtures/expense-parser-benchmark-corpus.js";
import { runParserBenchmark } from "../src/parserBenchmark.js";

function resultFor(fixture, overrides = {}) {
  return {
    expenses: fixture.expected.expenses.map((expense, index) => ({
      ...expense,
      ...(overrides[index] ?? {})
    })),
    notes: []
  };
}

test("synthetic corpus is fixed, invented, bilingual, and covers benchmark dimensions", () => {
  assert.ok(Object.isFrozen(EXPENSE_PARSER_BENCHMARK_CORPUS));
  assert.ok(EXPENSE_PARSER_BENCHMARK_CORPUS.length >= 6);
  assert.deepEqual(new Set(EXPENSE_PARSER_BENCHMARK_CORPUS.map((item) => item.language)), new Set(["ru", "en"]));
  assert.equal(new Set(EXPENSE_PARSER_BENCHMARK_CORPUS.map((item) => item.id)).size, EXPENSE_PARSER_BENCHMARK_CORPUS.length);
  assert.ok(EXPENSE_PARSER_BENCHMARK_CORPUS.every((item) => /^[a-z0-9_]+$/.test(item.id)));
  assert.ok(EXPENSE_PARSER_BENCHMARK_CORPUS.every((item) => item.input && item.now && item.timeZone && item.defaultCurrency));
  assert.ok(EXPENSE_PARSER_BENCHMARK_CORPUS.some((item) => item.expected.expenses.length > 1));
  assert.ok(EXPENSE_PARSER_BENCHMARK_CORPUS.some((item) => item.expected.expenses.some((expense) => expense.budget_impact === "large_oneoff")));
  assert.ok(EXPENSE_PARSER_BENCHMARK_CORPUS.some((item) => item.expected.expenses.some((expense) => expense.budget_impact === "planned")));
  assert.ok(EXPENSE_PARSER_BENCHMARK_CORPUS.some((item) => item.expected.expenses.some((expense) => expense.needs_review)));
  const allowedCategories = new Set(CATEGORIES.map((category) => category.slug));
  assert.ok(EXPENSE_PARSER_BENCHMARK_CORPUS.every((item) => (
    item.expected.expenses.every((expense) => allowedCategories.has(expense.category_slug))
  )));
});

test("runner reports critical and reviewable correctness separately per model and language", async () => {
  const corpus = EXPENSE_PARSER_BENCHMARK_CORPUS.slice(0, 2);
  const report = await runParserBenchmark({
    corpus,
    variants: [{ model: "model-current" }, { model: "model-candidate" }],
    parse: async ({ model, fixture }) => ({
      result: resultFor(fixture, model === "model-candidate" && fixture.language === "en"
        ? { 0: { category_slug: "other", needs_review: true } }
        : {}),
      llmHttpMs: fixture.language === "ru" ? 10 : 20
    })
  });

  assert.equal(report.variants.length, 2);
  assert.equal(report.variants[0].correctness.overall.critical.correctCases, 2);
  assert.equal(report.variants[0].correctness.overall.critical.totalCases, 2);
  assert.equal(report.variants[0].correctness.overall.critical.caseAccuracy, 1);
  assert.equal(report.variants[0].correctness.overall.critical.correctFields, 10);
  assert.equal(report.variants[0].correctness.overall.critical.totalFields, 10);
  assert.equal(report.variants[0].correctness.overall.critical.fieldAccuracy, 1);
  assert.deepEqual(report.variants[0].correctness.overall.critical.fields, {
    expense_count: { correct: 2, total: 2, accuracy: 1 },
    amount: { correct: 2, total: 2, accuracy: 1 },
    currency: { correct: 2, total: 2, accuracy: 1 },
    local_calendar_day: { correct: 2, total: 2, accuracy: 1 },
    budget_impact: { correct: 2, total: 2, accuracy: 1 }
  });
  assert.equal(report.variants[1].correctness.overall.critical.caseAccuracy, 1);
  assert.equal(report.variants[1].correctness.overall.reviewable.caseAccuracy, 0.5);
  assert.deepEqual(report.variants[1].correctness.overall.reviewable.fields, {
    category_slug: { correct: 1, total: 2, accuracy: 0.5 },
    needs_review: { correct: 1, total: 2, accuracy: 0.5 }
  });
  assert.equal(report.variants[1].correctness.byLanguage.ru.reviewable.caseAccuracy, 1);
  assert.equal(report.variants[1].correctness.byLanguage.en.reviewable.caseAccuracy, 0);
});

test("critical scoring compares local calendar day and normalizes a missing budget impact to regular", async () => {
  const fixture = EXPENSE_PARSER_BENCHMARK_CORPUS.find((item) => item.id === "en_timezone_yesterday");
  const report = await runParserBenchmark({
    corpus: [fixture],
    variants: [{ model: "candidate" }],
    parse: async () => ({
      result: resultFor(fixture, {
        0: {
          spent_at: "2026-07-20T01:00:00.000Z",
          budget_impact: undefined
        }
      }),
      llmHttpMs: 12
    })
  });

  const critical = report.variants[0].correctness.overall.critical;
  assert.equal(critical.correctFields, 5, "same New York local day and normalized regular impact are correct");
  assert.equal(critical.caseAccuracy, 1);
});

test("latency P50/P95 uses supplied llmHttpMs independently from correctness", async () => {
  const corpus = EXPENSE_PARSER_BENCHMARK_CORPUS.slice(0, 2);
  const latencies = [100, 10, 40, 20, 30];
  let call = 0;
  const report = await runParserBenchmark({
    corpus,
    variants: [{ model: "candidate" }],
    runs: 5,
    parse: async ({ fixture }) => {
      const runIndex = Math.floor(call / corpus.length);
      call += 1;
      return {
        result: fixture.language === "ru" ? { expenses: [], notes: [] } : resultFor(fixture),
        llmHttpMs: latencies[runIndex]
      };
    }
  });

  const variant = report.variants[0];
  assert.deepEqual(variant.latency.overall, { sampleCount: 10, p50Ms: 30, p95Ms: 100 });
  assert.deepEqual(variant.latency.byLanguage.ru, { sampleCount: 5, p50Ms: 30, p95Ms: 100 });
  assert.equal(variant.correctness.byLanguage.ru.critical.caseAccuracy, 0);
  assert.equal(variant.correctness.byLanguage.en.critical.caseAccuracy, 1);
});

test("failures expose only synthetic case id and a fixed error code", async () => {
  const fixture = EXPENSE_PARSER_BENCHMARK_CORPUS[0];
  const secret = "raw provider failure with input and credentials";
  const report = await runParserBenchmark({
    corpus: [fixture],
    variants: [{ model: "candidate" }],
    parse: async () => {
      const error = new Error(secret);
      error.llmHttpMs = 33;
      throw error;
    }
  });

  assert.deepEqual(report.variants[0].errors, [{ caseId: fixture.id, code: "benchmark_request_failed" }]);
  assert.deepEqual(report.variants[0].latency.overall, { sampleCount: 1, p50Ms: 33, p95Ms: 33 });
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(JSON.stringify(report).includes(fixture.input), false);
});
