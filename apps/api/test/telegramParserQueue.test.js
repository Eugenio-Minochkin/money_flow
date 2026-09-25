import test from "node:test";
import assert from "node:assert/strict";

import { createExpenseParser, evaluateLocalFastPath } from "../src/expenseParser.js";
import { createTelegramJobQueue } from "../src/telegramJobQueue.js";
import { parseExpenseText } from "../../../packages/shared/src/parser.js";

// A genuinely rejected input must not delay independent same-user local parsing.
for (const [localText, acceptance, route] of [
  ["кофейня 15 лари", "local_safe", "local_primary"],
  ["Zeta 15 лари", "local_reviewable", "local_review"]
]) test(`independent ${acceptance} parsing completes while same-user LLM remains pending`, { timeout: 5_000 }, async (t) => {
  const now = () => new Date("2026-09-23T12:00:00Z");
  const rejectedText = "coffee 80 taxi 120";
  assert.equal(evaluateLocalFastPath({
    text: rejectedText,
    localResult: parseExpenseText(rejectedText, { now: now(), defaultCurrency: "GEL" })
  }).localAcceptanceLevel, "local_rejected");

  const llmStarted = Promise.withResolvers();
  const llmRelease = Promise.withResolvers();
  t.after(() => llmRelease.resolve());
  const starts = [];
  const traces = [];
  let llmCalls = 0;
  const parser = createExpenseParser({
    apiKey: "synthetic-test-key",
    fastPathMode: "enabled",
    localFirstRolloutPercent: 100,
    parserTextHashSecret: "synthetic-rollout-secret",
    now,
    fetchImpl: async () => {
      llmCalls += 1;
      llmStarted.resolve();
      await llmRelease.promise;
      throw new Error("injected LLM failure");
    }
  });
  const queue = createTelegramJobQueue({ globalConcurrency: 2 });
  const first = queue.enqueue({
    userId: 7,
    independent: true,
    run: () => {
      starts.push("llm");
      return parser.parse(rejectedText, { userId: 7, defaultCurrency: "GEL" });
    }
  });
  const firstFailure = assert.rejects(first.promise, /injected LLM failure/);
  await llmStarted.promise;
  const second = queue.enqueue({
    userId: 7,
    independent: true,
    run: () => {
      starts.push("same-user-local");
      return parser.parse(localText, {
        userId: 7,
        defaultCurrency: "GEL",
        onLlmTrace: (metadata) => traces.push(metadata)
      });
    }
  });
  const otherUser = queue.enqueue({
    userId: 8,
    run: () => {
      starts.push("other-user-local");
      return parser.parse("обед 31,10 лари", { userId: 8, defaultCurrency: "GEL" });
    }
  });

  try {
    await second.promise;
    await otherUser.promise;
    assert.equal(second.status, "accepted");
    assert.deepEqual(starts, ["llm", "same-user-local", "other-user-local"]);
    assert.equal(llmCalls, 1);
  } finally {
    llmRelease.resolve();
    await firstFailure;
  }
  const result = await second.promise;
  assert.deepEqual(starts, ["llm", "same-user-local", "other-user-local"]);
  assert.equal(result.expenses[0].amount, 15);
  assert.equal(result.expenses[0].currency, "GEL");
  assert.equal(traces[0].localAcceptanceLevel, acceptance);
  assert.equal(traces[0].parserRoute, route);
  assert.equal(llmCalls, 1);
});
