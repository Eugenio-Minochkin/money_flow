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

test("updates user budget and display currency settings", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql, params });
    return {
      rows: [{
        monthly_budget_amount: params[0],
        base_currency: params[1],
        display_currency: params[2],
        usd_thb_rate: params[3]
      }]
    };
  }));

  const user = await repo.updateUserSettings(100, {
    monthlyBudgetAmount: 60000,
    baseCurrency: "THB",
    displayCurrency: "USD",
    usdThbRate: 36.5
  });

  assert.equal(Number(user.monthly_budget_amount), 60000);
  assert.equal(user.display_currency, "USD");
  assert.equal(Number(user.usd_thb_rate), 36.5);
  assert.equal(queries[0].params[4], 100);
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
      description: params[6],
      category_slug: params[7],
      tags: params[8],
      spent_at: params[9]
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

test("paying a planned expense creates an expense and records payment month", async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (String(sql).includes("SELECT planned_expenses.*, users.base_currency")) {
        return {
          rows: [{
            id: "5",
            user_id: "1",
            amount: "17000",
            currency: "THB",
            amount_base: "17000",
            description: "квартира",
            category_slug: "home",
            tags: ["дом"],
            base_currency: "THB"
          }]
        };
      }
      if (String(sql).includes("INSERT INTO expenses")) {
        return {
          rows: [{
            id: "20",
            amount_original: params[1],
            currency_original: params[2],
            amount_base: params[3],
            description: params[7],
            category_slug: params[8]
          }]
        };
      }
      if (String(sql).includes("INSERT INTO planned_expense_payments")) return { rows: [{ id: "9" }] };
      return { rows: [] };
    },
    release() {}
  };
  const repo = createRepository({
    async connect() {
      return client;
    }
  });

  const expense = await repo.payPlannedExpenseForTelegramUser(5, 100, new Date("2026-06-17T09:00:00+07:00"));

  assert.equal(expense.description, "квартира");
  assert.equal(Number(expense.amount_original), 17000);
  assert.ok(queries.some((query) => String(query.sql).includes("INSERT INTO planned_expense_payments")));
  assert.ok(queries.some((query) => String(query.sql) === "COMMIT"));
});

test("dashboard excludes current-month paid planned expenses from reserve", async () => {
  const repo = createRepository(fakePool((sql) => {
    if (String(sql).startsWith("SELECT * FROM users")) {
      return { rows: [{ id: "1", telegram_user_id: "100", monthly_budget_amount: "45000" }] };
    }
    if (String(sql).includes("planned_expense_payments")) {
      return {
        rows: [{
          id: "5",
          amount: "17000",
          amount_base: "17000",
          currency: "THB",
          description: "квартира",
          category_slug: "home",
          recurrence: "monthly",
          due_day: 17,
          paid_month: "2026-06"
        }]
      };
    }
    if (String(sql).includes("COALESCE(SUM(amount_base)")) return { rows: [{ total: 0 }] };
    if (String(sql).includes("FROM expenses") && String(sql).includes("ORDER BY spent_at")) return { rows: [] };
    if (String(sql).includes("GROUP BY category_slug")) return { rows: [] };
    return { rows: [] };
  }));

  const dashboard = await repo.dashboard(100, new Date("2026-06-10T10:00:00+07:00"));

  assert.equal(dashboard.snapshot.plannedRemaining, 0);
  assert.equal(dashboard.snapshot.freeRemaining, 45000);
});

test("dashboard returns USD display totals from converted amounts", async () => {
  const repo = createRepository(fakePool((sql) => {
    if (String(sql).startsWith("SELECT * FROM users")) {
      return {
        rows: [{
          id: "1",
          telegram_user_id: "100",
          monthly_budget_amount: "45000",
          display_currency: "USD",
          usd_thb_rate: "36"
        }]
      };
    }
    if (String(sql).includes("planned_expense_payments")) return { rows: [] };
    if (String(sql).includes("display_total")) return { rows: [{ total: 3600, display_total: 100 }] };
    if (String(sql).includes("FROM expenses") && String(sql).includes("ORDER BY spent_at")) {
      return {
        rows: [{
          id: "7",
          amount_original: "3600",
          currency_original: "THB",
          amount_base: "3600",
          converted_amounts: { THB: 3600, USD: 100 },
          description: "ужин",
          category_slug: "food_cafe",
          tags: [],
          spent_at: "2026-06-01T10:00:00.000Z"
        }]
      };
    }
    if (String(sql).includes("GROUP BY category_slug")) {
      return { rows: [{ category_slug: "food_cafe", total: 3600, display_total: 100 }] };
    }
    return { rows: [] };
  }));

  const dashboard = await repo.dashboard(100, new Date("2026-06-10T10:00:00+07:00"));

  assert.equal(dashboard.snapshot.display.currency, "USD");
  assert.equal(dashboard.snapshot.display.month, 100);
  assert.equal(dashboard.latestExpenses[0].display.amount, 100);
  assert.equal(dashboard.topCategories[0].display.amount, 100);
});

function fakePool(handler) {
  return {
    async query(sql, params = []) {
      return handler(sql, params);
    }
  };
}
