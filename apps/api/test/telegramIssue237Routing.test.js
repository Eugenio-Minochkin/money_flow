import test from "node:test";
import assert from "node:assert/strict";
import { createExpenseParser } from "../src/expenseParser.js";

test("issue 237 dinner and groceries both use local-safe parsing in the enabled cohort", async () => {
  const parser = createExpenseParser({
    apiKey: "synthetic", fastPathMode: "enabled", localFirstRolloutPercent: 100,
    parserTextHashSecret: "synthetic", now: () => new Date("2026-09-24T12:00:00Z"),
    fetchImpl: async () => { assert.fail("local-safe input must not call the LLM"); }
  });
  for (const text of ["Ужин 40 лари", "Продукты в магазине 12,64 лари"]) {
    const traces = [];
    const result = await parser.parse(text, { userId: 1, rolloutUserId: 100, defaultCurrency: "GEL", onLlmTrace: trace => traces.push(trace) });
    assert.equal(result.expenses.length, 1);
    assert.equal(traces.at(-1).parserRoute, "local_primary");
    assert.equal(traces.at(-1).localAcceptanceLevel, "local_safe");
    assert.equal(traces.at(-1).llmSkipped, true);
  }
});
