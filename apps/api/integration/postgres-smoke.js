import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { migrate } from "../src/db.js";
import { createRepository } from "../src/repository.js";

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(__dirname, "../migrations");
const databaseUrl = process.env.DATABASE_URL;

assertSafeTestDatabase(databaseUrl);

const pool = new Pool({ connectionString: databaseUrl });
const repo = createRepository(pool);

test.before(async () => {
  await resetPublicSchema();
  await migrate({ pool, migrationsDir, logger: quietLogger });
  await migrate({ pool, migrationsDir, logger: quietLogger });

  const applied = await pool.query("SELECT filename FROM schema_migrations ORDER BY filename");
  assert.deepEqual(
    applied.rows.map((row) => row.filename),
    ["001_initial.sql", "002_draft_confirm_flow.sql", "003_budget_topups.sql", "004_report_deliveries.sql", "005_exchange_rates.sql"]
  );
});

test.beforeEach(async () => {
  await truncateDomainTables();
});

test.after(async () => {
  await pool.end();
});

test("creates a Telegram user with persisted defaults", async () => {
  const user = await repo.upsertTelegramUser({
    id: 990001,
    firstName: "Smoke",
    username: "pg_smoke"
  });

  assert.equal(user.telegram_user_id, "990001");
  assert.equal(user.onboarding_step, "language");

  const stored = await pool.query("SELECT * FROM users WHERE telegram_user_id = $1", [990001]);
  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].base_currency, "THB");
  assert.equal(stored.rows[0].display_currency, "USD");
  assert.equal(stored.rows[0].timezone, "Asia/Bangkok");
  assert.equal(stored.rows[0].interface_language, "en");
  assert.equal(stored.rows[0].budget_advice_enabled, true);
});

test("saves a confirmed draft expense and reads it back", async () => {
  const user = await createSmokeUser(990002);
  const draft = await repo.createDraft(user.id, "coffee 120", [
    expenseItem({
      amount: 120,
      description: "coffee",
      category_slug: "food_cafe",
      tags: ["latte"],
      spent_at: "2026-06-24T03:00:00.000Z"
    })
  ]);

  const saved = await repo.saveDraftAsExpense(draft.id, 990002);

  assert.equal(saved.alreadySaved, false);
  assert.equal(saved.expenses.length, 1);
  assert.equal(Number(saved.expenses[0].amount_base), 120);
  assert.equal(saved.expenses[0].currency_original, "THB");
  assert.equal(saved.expenses[0].category_slug, "food_cafe");
  assert.equal(saved.expenses[0].budget_impact, "regular");

  const expenses = await repo.listExpensesForTelegramUser(990002, {
    period: "month",
    now: new Date("2026-06-24T12:00:00+07:00")
  });
  assert.equal(expenses.length, 1);
  assert.equal(expenses[0].description, "coffee");
  assert.deepEqual(expenses[0].tags, ["latte"]);
});

test("recalculates dashboard budget summary from real expense rows", async () => {
  const user = await createSmokeUser(990003);
  await repo.updateMonthlyBudget(990003, 45000, new Date("2026-06-01T00:00:00+07:00"));
  await saveExpense(user.id, 990003, {
    amount: 1000,
    description: "groceries",
    category_slug: "food_groceries",
    spent_at: "2026-06-03T05:00:00.000Z"
  });
  await saveExpense(user.id, 990003, {
    amount: 500,
    description: "lunch",
    category_slug: "food_cafe",
    spent_at: "2026-06-24T05:00:00.000Z"
  });

  const dashboard = await repo.dashboard(990003, new Date("2026-06-24T12:00:00+07:00"));

  assert.equal(dashboard.snapshot.monthlyBudget, 45000);
  assert.equal(dashboard.snapshot.month, 1500);
  assert.equal(dashboard.snapshot.today, 500);
  assert.equal(dashboard.snapshot.freeRemaining, 43500);
  assert.equal(dashboard.latestExpenses.length, 2);
  assert.equal(dashboard.topCategories[0].category_slug, "food_groceries");
});

test("creates, lists, pays, and deactivates a planned payment", async () => {
  await createSmokeUser(990004);
  const planned = await repo.createPlannedExpense(990004, {
    amount: 2000,
    currency: "THB",
    description: "rent",
    category_slug: "home",
    recurrence: "monthly",
    due_day: 30,
    due_days: [30],
    tags: ["fixed"]
  }, new Date("2026-07-01T00:00:00+07:00"));

  assert.equal(Number(planned.amount_base), 2000);

  let plannedRows = await repo.listPlannedExpensesForTelegramUser(990004);
  assert.equal(plannedRows.length, 1);
  assert.equal(plannedRows[0].description, "rent");

  const paid = await repo.payPlannedExpenseForTelegramUser(
    planned.id,
    990004,
    new Date("2026-07-30T10:00:00+07:00"),
    { occurrenceDate: "2026-07-30" }
  );
  assert.equal(paid.budget_impact, "planned");

  plannedRows = await repo.listPlannedExpensesForTelegramUser(990004);
  assert.equal(plannedRows[0].paid_count, 1);
  assert.deepEqual(plannedRows[0].paid_occurrence_dates, ["2026-07-30"]);

  await repo.deactivatePlannedExpense(990004, planned.id);
  plannedRows = await repo.listPlannedExpensesForTelegramUser(990004);
  assert.equal(plannedRows.length, 0);
});

test("creates and reads a current reserve through dashboard state", async () => {
  await createSmokeUser(990005);
  await repo.updateMonthlyBudget(990005, 45000, new Date("2026-06-01T00:00:00+07:00"));

  const reserve = await repo.upsertCurrentReserve(990005, {
    amount: 5000,
    title: "camera",
    scope: "current_and_future"
  }, new Date("2026-06-24T12:00:00+07:00"));

  assert.equal(Number(reserve.reserve.reserve_amount), 5000);
  assert.equal(reserve.reserve.period, "2026-06");
  assert.equal(Number(reserve.template.amount), 5000);

  const dashboard = await repo.dashboard(990005, new Date("2026-06-24T12:00:00+07:00"));
  assert.equal(dashboard.snapshot.reserve.amount, 5000);
  assert.equal(dashboard.reserveInstance.status, "active");
  assert.equal(dashboard.reserveTemplate.is_active, true);
});

test("edits and deletes an expense so it no longer participates in totals", async () => {
  const user = await createSmokeUser(990006);
  const created = await saveExpense(user.id, 990006, {
    amount: 250,
    description: "snack",
    category_slug: "food_cafe",
    spent_at: "2026-06-24T05:00:00.000Z"
  });

  const updated = await repo.updateExpenseForTelegramUser(created.id, 990006, expenseItem({
    amount: 400,
    description: "pharmacy",
    category_slug: "health",
    tags: ["medicine"],
    spent_at: "2026-06-24T06:00:00.000Z"
  }));
  assert.equal(Number(updated.amount_original), 400);
  assert.equal(updated.category_slug, "health");
  assert.deepEqual(updated.tags, ["medicine"]);

  let dashboard = await repo.dashboard(990006, new Date("2026-06-24T12:00:00+07:00"));
  assert.equal(dashboard.snapshot.month, 400);

  const deleted = await repo.deleteExpenseForTelegramUser(created.id, 990006);
  assert.equal(Number(deleted.amount_original), 400);

  dashboard = await repo.dashboard(990006, new Date("2026-06-24T12:00:00+07:00"));
  assert.equal(dashboard.snapshot.month, 0);
  assert.equal(dashboard.latestExpenses.length, 0);
});

test("uses user timezone boundaries for day and month expense queries", async () => {
  const user = await createSmokeUser(990007);
  await repo.updateUserSettings(990007, {
    monthlyBudgetAmount: 45000,
    weeklyBudgetAmount: null,
    usdThbRate: 32.65,
    baseCurrency: "THB",
    displayCurrency: "USD",
    interfaceLanguage: "en",
    interfaceTheme: "light",
    timezone: "Asia/Bangkok"
  }, new Date("2026-07-01T00:00:00+07:00"));

  await saveExpense(user.id, 990007, {
    amount: 700,
    description: "local July breakfast",
    category_slug: "food_cafe",
    spent_at: "2026-06-30T18:30:00.000Z"
  });
  await saveExpense(user.id, 990007, {
    amount: 300,
    description: "late June dinner",
    category_slug: "food_cafe",
    spent_at: "2026-06-30T15:30:00.000Z"
  });

  const julyDay = await repo.listExpensesForTelegramUser(990007, {
    period: "today",
    now: new Date("2026-07-01T12:00:00+07:00")
  });
  assert.equal(julyDay.length, 1);
  assert.equal(julyDay[0].description, "local July breakfast");

  const dashboard = await repo.dashboard(990007, new Date("2026-07-01T12:00:00+07:00"));
  assert.equal(dashboard.snapshot.today, 700);
  assert.equal(dashboard.snapshot.month, 700);
});

async function createSmokeUser(telegramUserId) {
  const user = await repo.upsertTelegramUser({
    id: telegramUserId,
    firstName: "Smoke",
    username: `pg_${telegramUserId}`
  });
  await repo.updateUserSettings(telegramUserId, {
    monthlyBudgetAmount: 45000,
    weeklyBudgetAmount: null,
    usdThbRate: 32.65,
    baseCurrency: "THB",
    displayCurrency: "USD",
    interfaceLanguage: "en",
    interfaceTheme: "light",
    timezone: "Asia/Bangkok"
  }, new Date("2026-06-01T00:00:00+07:00"));
  return repo.getUserByTelegramId(telegramUserId);
}

async function saveExpense(userId, telegramUserId, overrides = {}) {
  const draft = await repo.createDraft(userId, overrides.description ?? "expense", [
    expenseItem(overrides)
  ]);
  const saved = await repo.saveDraftAsExpense(draft.id, telegramUserId);
  return saved.expenses[0];
}

function expenseItem(overrides = {}) {
  return {
    amount: overrides.amount ?? 100,
    currency: overrides.currency ?? "THB",
    description: overrides.description ?? "expense",
    category_slug: overrides.category_slug ?? "food_cafe",
    category_source: overrides.category_source ?? "user",
    tags: overrides.tags ?? [],
    spent_at: overrides.spent_at ?? "2026-06-24T05:00:00.000Z",
    budget_impact: overrides.budget_impact ?? "regular"
  };
}

async function resetPublicSchema() {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

async function truncateDomainTables() {
  const result = await pool.query(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> 'schema_migrations'
    ORDER BY tablename
  `);
  if (!result.rows.length) return;
  const tableList = result.rows.map((row) => `"public"."${row.tablename.replaceAll('"', '""')}"`).join(", ");
  await pool.query(`TRUNCATE ${tableList} RESTART IDENTITY CASCADE`);
}

function assertSafeTestDatabase(value) {
  assert.ok(value, "DATABASE_URL is required for Postgres integration tests");
  const url = new URL(value);
  const databaseName = url.pathname.replace(/^\//, "");
  assert.ok(
    ["localhost", "127.0.0.1"].includes(url.hostname),
    "Postgres integration tests require a localhost DATABASE_URL"
  );
  assert.match(
    databaseName,
    /(^|_)test($|_)/,
    "Postgres integration tests require a test database name"
  );
}

const quietLogger = {
  info() {},
  error() {}
};
