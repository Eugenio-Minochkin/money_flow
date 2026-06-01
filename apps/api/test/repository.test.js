import test from "node:test";
import assert from "node:assert/strict";

import { createRepository } from "../src/repository.js";

test("updates monthly budget for a Telegram user", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql, params });
    return { rows: [{ monthly_budget_amount: "60000" }] };
  }));

  const user = await repo.updateMonthlyBudget(100, 60000);

  assert.equal(Number(user.monthly_budget_amount), 60000);
  assert.equal(queries[0].params[0], 60000);
  assert.equal(queries[0].params[1], 100);
});

test("returns a draft owned by a Telegram user", async () => {
  const repo = createRepository(fakePool(() => ({
    rows: [{ id: "42", status: "pending", items: [{ description: "кофе" }] }]
  })));

  const draft = await repo.getDraftForTelegramUser(42, 100);

  assert.equal(draft.id, "42");
  assert.equal(draft.items[0].description, "кофе");
});

test("updates pending draft items for a Telegram user", async () => {
  const items = [{ amount: 90, currency: "THB", description: "кофе" }];
  const repo = createRepository(fakePool((_sql, params) => ({
    rows: [{ id: "42", status: "pending", items: JSON.parse(params[0]) }]
  })));

  const draft = await repo.updateDraftItems(42, 100, items);

  assert.equal(draft.items[0].amount, 90);
});

test("updates an expense owned by a Telegram user", async () => {
  const repo = createRepository(fakePool((_sql, params) => ({
    rows: [{
      id: "7",
      amount_original: params[0],
      amount_base: params[0],
      currency_original: params[1],
      description: params[4],
      category_slug: params[5],
      tags: params[6],
      spent_at: params[7]
    }]
  })));

  const expense = await repo.updateExpenseForTelegramUser(7, 100, {
    amount: 120,
    currency: "THB",
    description: "завтрак",
    category_slug: "food_cafe",
    tags: ["еда"],
    spent_at: "2026-06-01T10:00:00+07:00"
  });

  assert.equal(Number(expense.amount_original), 120);
  assert.equal(expense.description, "завтрак");
});

test("deletes an expense owned by a Telegram user", async () => {
  const repo = createRepository(fakePool((_sql, params) => ({
    rows: [{ id: params[0] }]
  })));

  const deleted = await repo.deleteExpenseForTelegramUser(7, 100);

  assert.equal(deleted.id, 7);
});

test("lists expenses for history", async () => {
  const repo = createRepository(fakePool(() => ({
    rows: [{ id: "1", description: "кофе" }]
  })));

  const expenses = await repo.listExpensesForTelegramUser(100, { period: "month", search: "кофе" });

  assert.equal(expenses[0].description, "кофе");
});

test("returns top categories", async () => {
  const repo = createRepository(fakePool(() => ({
    rows: [{ category_slug: "food_cafe", total: 1200 }]
  })));

  const categories = await repo.topCategories(1, new Date("2026-06-07T10:00:00+07:00"));

  assert.equal(categories[0].category_slug, "food_cafe");
  assert.equal(categories[0].total, 1200);
});

test("creates and lists planned expenses", async () => {
  const repo = createRepository(fakePool((_sql, params) => {
    if (String(_sql).startsWith("INSERT")) {
      return { rows: [{ id: "5", description: params[4], recurrence: params[7] }] };
    }
    return { rows: [{ id: "5", description: "ChatGPT", recurrence: "monthly" }] };
  }));

  const created = await repo.createPlannedExpense(100, {
    amount: 20,
    currency: "USD",
    amount_base: 20,
    description: "ChatGPT",
    category_slug: "subscriptions",
    tags: ["регулярная трата"],
    recurrence: "monthly",
    due_day: 10
  });
  const planned = await repo.listPlannedExpensesForTelegramUser(100);

  assert.equal(created.description, "ChatGPT");
  assert.equal(planned[0].recurrence, "monthly");
});

function fakePool(handler) {
  return {
    async query(sql, params = []) {
      return handler(sql, params);
    }
  };
}
