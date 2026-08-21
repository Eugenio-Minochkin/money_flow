import assert from "node:assert/strict";
import test from "node:test";

import { processShortcutCapture, shortcutTerminalSummary } from "../src/shortcutCapture.js";

const user = {
  id: 7,
  telegram_user_id: 100,
  base_currency: "THB",
  timezone: "Asia/Bangkok"
};

function item(overrides = {}) {
  return {
    amount: 180,
    currency: "THB",
    description: "Coffee",
    category_slug: "food_cafe",
    category_source: "parser",
    needs_review: false,
    spent_at: "2026-08-14T08:00:00.000Z",
    budget_impact: "regular",
    ...overrides
  };
}

function createRepository(items) {
  let draft = null;
  let expense = null;
  return {
    async claimShortcutRequest() {
      return draft ? { state: "completed", draft } : { state: "claimed", claimVersion: 1 };
    },
    async completeShortcutRequest({ sourceText, items: parsedItems }) {
      draft = { id: 41, status: "pending", source_text: sourceText, items: parsedItems };
      return { draft };
    },
    async releaseShortcutRequest() {},
    async recordAppEvent() {},
    async listClosedReserveMonthsForTelegramUser() { return []; },
    async saveDraftAsExpense() {
      if (!expense) {
        expense = {
          id: 91,
          draft_id: draft.id,
          amount_original: items[0].amount,
          currency_original: items[0].currency,
          description: items[0].description,
          category_slug: items[0].category_slug
        };
        return { expenses: [expense], alreadySaved: false };
      }
      return { expenses: [expense], alreadySaved: true };
    },
    financialFacts() { return expense ? 1 : 0; }
  };
}

test("safe Shortcut capture saves immediately with a compact result", async () => {
  const items = [item()];
  const repository = createRepository(items);

  const result = await processShortcutCapture({
    user,
    tokenId: 9,
    clientRequestId: "safe-shortcut-request",
    text: "coffee 180",
    expenseParser: { parse: async () => ({ expenses: items }) },
    repository,
    now: new Date("2026-08-14T09:00:00.000Z")
  });

  assert.equal(result.state, "saved");
  assert.equal(result.expense.id, 91);
  assert.equal(result.summary, "Saved.");
  assert.equal(result.replayed, false);
  assert.equal(result.alreadySaved, false);
  assert.equal(repository.financialFacts(), 1);
});

test("Shortcut replies use concise terminal RU/EN Siri wording", async () => {
  const items = [item()];
  const russian = await processShortcutCapture({ user: { ...user, interface_language: "ru" }, tokenId: 9, clientRequestId: "russian-wording", text: "coffee 180", expenseParser: { parse: async () => ({ expenses: items }) }, repository: createRepository(items) });
  const review = await processShortcutCapture({ user: { ...user, interface_language: "ru" }, tokenId: 9, clientRequestId: "russian-review-wording", text: "coffee 180", expenseParser: { parse: async () => ({ expenses: [item({ needs_review: true })] }) }, repository: createRepository([item({ needs_review: true })]) });

  assert.equal(russian.summary, "Занесено.");
  assert.equal(review.summary, "Нужно проверить расход в Telegram — откройте Money Flow.");
  assert.equal(shortcutTerminalSummary("failed", "ru"), "Не удалось занести расход. Добавьте его вручную в Telegram через Money Flow.");
  assert.equal(shortcutTerminalSummary("failed", "en"), "Could not save the expense. Add it manually in Money Flow on Telegram.");
});

for (const scenario of [
  { name: "needs review", items: [item({ needs_review: true })], reason: "needs_review" },
  { name: "category-required", items: [item({ category_slug: "other" })], reason: "category_required" },
  { name: "multiple items", items: [item(), item({ description: "Taxi" })], reason: "multiple_items" }
]) {
  test(`Shortcut ${scenario.name} capture remains a shared review draft`, async () => {
    const repository = createRepository(scenario.items);
    const result = await processShortcutCapture({
      user,
      tokenId: 9,
      clientRequestId: `review-${scenario.reason}`,
      text: "uncertain expense",
      expenseParser: { parse: async () => ({ expenses: scenario.items }) },
      repository,
      now: new Date("2026-08-14T09:00:00.000Z")
    });

    assert.equal(result.state, "review");
    assert.equal(result.draft.id, 41);
    assert.equal(result.reason, scenario.reason);
    assert.equal(result.replayed, false);
    assert.equal(repository.financialFacts(), 0);
  });
}

test("completed Shortcut replay returns the original saved expense without parsing", async () => {
  const items = [item()];
  const repository = createRepository(items);
  let parserCalls = 0;
  const input = {
    user,
    tokenId: 9,
    clientRequestId: "lost-response-request",
    text: "coffee 180",
    expenseParser: { parse: async () => { parserCalls += 1; return { expenses: items }; } },
    repository,
    now: new Date("2026-08-14T09:00:00.000Z")
  };

  const first = await processShortcutCapture(input);
  const replay = await processShortcutCapture(input);

  assert.equal(parserCalls, 1);
  assert.equal(replay.state, "saved");
  assert.equal(replay.expense.id, first.expense.id);
  assert.equal(replay.replayed, true);
  assert.equal(replay.alreadySaved, true);
  assert.equal(repository.financialFacts(), 1);
});

test("confirmed Shortcut replay stays saved even if its source month is now closed", async () => {
  let parserCalls = 0;
  const expense = {
    id: 92,
    draft_id: 42,
    amount_original: 180,
    currency_original: "THB",
    description: "Coffee",
    category_slug: "food_cafe"
  };
  const result = await processShortcutCapture({
    user,
    tokenId: 9,
    clientRequestId: "confirmed-closed-month-replay",
    text: "coffee 180",
    expenseParser: { parse: async () => { parserCalls += 1; return { expenses: [] }; } },
    repository: {
      async claimShortcutRequest() {
        return { state: "completed", draft: { id: 42, status: "confirmed", items: [item()] } };
      },
      async listClosedReserveMonthsForTelegramUser() { return ["2026-08"]; },
      async saveDraftAsExpense() { return { expenses: [expense], alreadySaved: true }; }
    },
    now: new Date("2026-08-14T09:00:00.000Z")
  });

  assert.equal(parserCalls, 0);
  assert.equal(result.state, "saved");
  assert.equal(result.expense.id, 92);
  assert.equal(result.replayed, true);
  assert.equal(result.alreadySaved, true);
});

test("concurrent Shortcut retries create one draft and one financial fact", async () => {
  const items = [item()];
  const repository = createRepository(items);
  let parserCalls = 0;
  let releaseParser;
  const parserGate = new Promise((resolve) => { releaseParser = resolve; });
  const input = {
    user,
    tokenId: 9,
    clientRequestId: "concurrent-safe-request",
    text: "coffee 180",
    expenseParser: { parse: async () => {
      parserCalls += 1;
      await parserGate;
      return { expenses: items };
    } },
    repository,
    now: new Date("2026-08-14T09:00:00.000Z")
  };

  const first = processShortcutCapture(input);
  const second = processShortcutCapture(input);
  releaseParser();
  const results = await Promise.all([first, second]);

  assert.equal(parserCalls, 1);
  assert.deepEqual(results.map((result) => result.expense.id), [91, 91]);
  assert.equal(repository.financialFacts(), 1);
});
