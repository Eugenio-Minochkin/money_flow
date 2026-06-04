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
        usd_thb_rate: params[3],
        weekly_budget_amount: params[4],
        interface_language: params[5],
        budget_advice_enabled: params[6],
        interface_theme: params[7]
      }]
    };
  }));

  const user = await repo.updateUserSettings(100, {
    monthlyBudgetAmount: 60000,
    weeklyBudgetAmount: 12000,
    baseCurrency: "THB",
    displayCurrency: "GEL",
    usdThbRate: 36.5,
    interfaceLanguage: "ru",
    budgetAdviceEnabled: false,
    interfaceTheme: "light"
  });

  assert.equal(Number(user.monthly_budget_amount), 60000);
  assert.equal(Number(user.weekly_budget_amount), 12000);
  assert.equal(user.display_currency, "GEL");
  assert.equal(user.interface_language, "ru");
  assert.equal(user.budget_advice_enabled, false);
  assert.equal(user.interface_theme, "light");
  assert.equal(Number(user.usd_thb_rate), 36.5);
  assert.equal(queries[0].params[3], 36.5);
  assert.equal(queries[0].params[4], 12000);
  assert.equal(queries[0].params[5], "ru");
  assert.equal(queries[0].params[6], false);
  assert.equal(queries[0].params[7], "light");
  assert.equal(queries[0].params[8], 100);
});

test("checks database health", async () => {
  const repo = createRepository(fakePool((sql) => {
    assert.match(sql, /SELECT 1 AS ok/);
    return { rows: [{ ok: 1 }] };
  }));

  assert.deepEqual(await repo.health(), { db: true });
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

test("lists inbox drafts for a Telegram user", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql, params });
    return {
      rows: [{
        id: "42",
        status: "inbox",
        source_text: "unknown 800",
        items: [{ amount: 800, currency: "THB", description: "unknown" }],
        created_at: "2026-06-02T10:00:00.000Z"
      }]
    };
  }));

  const drafts = await repo.listDraftsForTelegramUser(100, { status: "inbox" });

  assert.equal(drafts[0].id, "42");
  assert.equal(drafts[0].status, "inbox");
  assert.equal(drafts[0].items[0].amount, 800);
  assert.equal(queries[1].params[0], 100);
  assert.equal(queries[1].params[1], "inbox");
});

test("moves stale pending drafts into inbox before listing drafts", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    if (String(sql).startsWith("UPDATE drafts")) return { rows: [] };
    return { rows: [] };
  }));

  await repo.listDraftsForTelegramUser(100, { status: "inbox" });

  assert.match(queries[0].sql, /SET status = 'inbox'/);
  assert.match(queries[0].sql, /created_at < now\(\) - \(\$2 \* interval '1 minute'\)/);
  assert.equal(queries[0].params[0], 100);
  assert.equal(queries[0].params[1], 30);
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
  const queries = [];
  const repo = createRepository(fakePool((sql) => {
    queries.push(String(sql));
    return {
    rows: [{ id: "1", description: "кофе" }]
    };
  }));

  const expenses = await repo.listExpensesForTelegramUser(100, { period: "month", search: "кофе" });

  assert.equal(expenses[0].description, "кофе");
  assert.doesNotMatch(queries.at(-1), /planned_expense_payments/);
  assert.doesNotMatch(queries.at(-1), /NOT EXISTS/);
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
      assert.match(String(_sql), /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11, \$12, true\)/);
      assert.equal(params.length, 12);
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
            description: params[8],
            category_slug: params[9]
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

test("planned RUB expenses are converted through dated THB rates", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql, params });
    if (String(sql).startsWith("SELECT * FROM users")) {
      return {
        rows: [{
          id: "1",
          telegram_user_id: "100",
          base_currency: "THB",
          display_currency: "USD",
          usd_thb_rate: "32.6"
        }]
      };
    }
    if (String(sql).startsWith("INSERT INTO planned_expenses")) {
      return {
        rows: [{
          id: "8",
          amount: params[1],
          currency: params[2],
          amount_base: params[3],
          description: params[4]
        }]
      };
    }
    return { rows: [] };
  }), {
    exchangeRates: fixedRates()
  });

  const planned = await repo.createPlannedExpense(100, {
    amount: 5000,
    currency: "RUB",
    description: "psychologist",
    category_slug: "health",
    recurrence: "monthly",
    due_day: 4
  });

  assert.equal(Number(planned.amount_base), 1800);
  assert.equal(queries.find((query) => String(query.sql).startsWith("INSERT INTO planned_expenses")).params[3], 1800);
});

test("IDR base users store amount_base in IDR", async () => {
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    if (query.startsWith("SELECT * FROM users")) {
      return {
        rows: [{
          id: "1",
          telegram_user_id: "100",
          base_currency: "IDR",
          display_currency: "USD",
          usd_thb_rate: "32.6"
        }]
      };
    }
    if (query.startsWith("INSERT INTO planned_expenses")) {
      return {
        rows: [{
          id: "9",
          amount: params[1],
          currency: params[2],
          amount_base: params[3]
        }]
      };
    }
    return { rows: [] };
  }), {
    exchangeRates: fixedRates()
  });

  const planned = await repo.createPlannedExpense(100, {
    amount: 1,
    currency: "USD",
    description: "test",
    category_slug: "other",
    recurrence: "one_off",
    due_date: "2026-06-10"
  });

  assert.equal(Number(planned.amount_base), 16200);
});

test("paying weekly planned expenses uses an occurrence key, not one payment per month", async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (String(sql).includes("SELECT planned_expenses.*, users.base_currency")) {
        return {
          rows: [{
            id: "5",
            user_id: "1",
            amount: "1000",
            currency: "THB",
            amount_base: "1000",
            description: "english",
            category_slug: "education",
            tags: [],
            recurrence: "weekly",
            weekday: 3,
            base_currency: "THB",
            usd_thb_rate: "32.6"
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
            converted_amounts: JSON.parse(params[5]),
            exchange_rate_source: params[7],
            description: params[8],
            category_slug: params[9]
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
  }, {
    exchangeRates: fixedRates()
  });

  const expense = await repo.payPlannedExpenseForTelegramUser(5, 100, new Date("2026-06-17T09:00:00+07:00"));
  const paymentQuery = queries.find((query) => String(query.sql).includes("INSERT INTO planned_expense_payments"));

  assert.equal(Number(expense.amount_base), 1000);
  assert.match(String(paymentQuery.sql), /paid_key/);
  assert.equal(paymentQuery.params[4], "2026-06:2026-06-17");
});

test("dashboard keeps unpaid twice-monthly occurrences in planned reserve", async () => {
  const repo = createRepository(fakePool((sql) => {
    if (String(sql).startsWith("SELECT * FROM users")) {
      return { rows: [{ id: "1", telegram_user_id: "100", monthly_budget_amount: "45000" }] };
    }
    if (String(sql).includes("planned_expense_payments")) {
      return {
        rows: [{
          id: "5",
          amount: "2000",
          amount_base: "2000",
          currency: "THB",
          description: "therapy",
          category_slug: "health",
          recurrence: "twice_monthly",
          due_days: [4, 18],
          paid_count: 1
        }]
      };
    }
    if (String(sql).includes("COALESCE(SUM(amount_base)")) return { rows: [{ total: 0 }] };
    if (String(sql).includes("FROM expenses") && String(sql).includes("ORDER BY spent_at")) return { rows: [] };
    if (String(sql).includes("GROUP BY category_slug")) return { rows: [] };
    return { rows: [] };
  }));

  const dashboard = await repo.dashboard(100, new Date("2026-06-10T10:00:00+07:00"));

  assert.equal(dashboard.snapshot.plannedRemaining, 2000);
  assert.equal(dashboard.snapshot.freeRemaining, 43000);
});

test("dashboard subtracts unpaid planned expenses due this week from weekly remaining", async () => {
  const repo = createRepository(fakePool((sql) => {
    const query = String(sql);
    if (query.startsWith("SELECT * FROM users")) {
      return {
        rows: [{
          id: "1",
          telegram_user_id: "100",
          monthly_budget_amount: "45000",
          weekly_budget_amount: "12000",
          display_currency: "USD",
          usd_thb_rate: "30"
        }]
      };
    }
    if (query.includes("planned_expense_payments")) {
      return {
        rows: [{
          id: "5",
          amount: "2000",
          amount_base: "2000",
          currency: "THB",
          description: "therapy",
          category_slug: "health",
          recurrence: "monthly",
          due_day: 12,
          due_days: [12],
          paid_count: 0
        }]
      };
    }
    if (query.includes("COALESCE(SUM(amount_base)") && query.includes("display_total")) {
      return { rows: [{ total: 3000, display_total: 100 }] };
    }
    if (query.includes("FROM expenses") && query.includes("ORDER BY spent_at")) return { rows: [] };
    if (query.includes("GROUP BY category_slug")) return { rows: [] };
    return { rows: [] };
  }));

  const dashboard = await repo.dashboard(100, new Date("2026-06-10T10:00:00+07:00"));

  assert.equal(dashboard.snapshot.weekPlanLimit, 12000);
  assert.equal(dashboard.snapshot.plannedThisWeek, 2000);
  assert.equal(dashboard.snapshot.weekRemaining, 7000);
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
  const queries = [];
  const repo = createRepository(fakePool((sql) => {
    queries.push(String(sql));
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
    if (String(sql).includes("planned_expense_payments")) return { rows: [] };
    if (String(sql).includes("display_total")) return { rows: [{ total: 3600, display_total: 100 }] };
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
  assert.ok(queries.some((query) => query.includes("ORDER BY spent_at") && !query.includes("planned_expense_payments")));
});

test("dashboard returns analytics blocks for the mini app", async () => {
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    if (query.startsWith("SELECT * FROM users")) {
      return {
        rows: [{
          id: "1",
          telegram_user_id: "100",
          monthly_budget_amount: "45000",
          display_currency: "USD",
          usd_thb_rate: "32.6"
        }]
      };
    }
    if (query.includes("planned_expense_payments")) return { rows: [] };
    if (query.includes("ORDER BY spent_at DESC")) return { rows: [] };
    if (query.includes("GROUP BY category_slug")) {
      return {
        rows: [
          { category_slug: "other", total: 600, display_total: 18.4 },
          { category_slug: "food_cafe", total: 2600, display_total: 79.76 }
        ]
      };
    }
    if (query.includes("ORDER BY amount_base DESC")) {
      return {
        rows: [{ id: "9", amount_base: "1500", amount_original: "1500", currency_original: "THB", converted_amounts: { THB: 1500, USD: 46.01 }, description: "dinner", category_slug: "food_cafe", tags: ["date"], spent_at: params[2] }]
      };
    }
    if (query.includes("unnest(tags)")) {
      return { rows: [{ tag: "date", total: 1500, display_total: 46.01 }] };
    }
    if (query.includes("COALESCE(SUM(amount_base)") && query.includes("display_total")) {
      return { rows: [{ total: 3200, display_total: 98.16 }] };
    }
    if (query.includes("EXTRACT(DAY")) {
      return { rows: [{ day: 1, total: 3200 }] };
    }
    return { rows: [] };
  }));

  const dashboard = await repo.dashboard(100, new Date("2026-06-10T10:00:00+07:00"));

  assert.equal(dashboard.analytics.largestWeek.description, "dinner");
  assert.equal(dashboard.analytics.largestMonth.description, "dinner");
  assert.equal(dashboard.analytics.topTags[0].tag, "date");
  assert.equal(dashboard.analytics.dailyHeatmap[0].day, 1);
  assert.equal(dashboard.analytics.weekComparison.current, 3200);
  assert.equal(dashboard.analytics.otherCategoryWarning.active, true);
});

function fakePool(handler) {
  return {
    async query(sql, params = []) {
      return handler(sql, params);
    }
  };
}

function fixedRates() {
  return {
    async ratesFor() {
      return {
        source: "test-rates",
        THB: { THB: 1 },
        USD: { THB: 32.6 },
        RUB: { THB: 0.36 },
        IDR: { THB: 32.6 / 16200 }
      };
    }
  };
}
