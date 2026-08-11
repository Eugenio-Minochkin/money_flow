import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { migrate } from "../src/db.js";
import { normalizePlannedDateKey } from "../src/plannedOccurrenceDates.js";
import { createRepository } from "../src/repository.js";
import { createShortcutExpenseDraft } from "../src/expenseDraftService.js";

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
    ["001_initial.sql", "002_draft_confirm_flow.sql", "003_budget_topups.sql", "004_report_deliveries.sql", "005_exchange_rates.sql", "006_feedback.sql", "007_account_deletion.sql", "008_product_analytics.sql", "009_telegram_expense_editor.sql", "010_telegram_editor_prompt_message.sql", "011_planned_expense_disabled_at.sql", "012_planned_expense_starts_on.sql", "013_planned_payment_reminders.sql", "014_quick_access_tokens.sql"]
  );

  const sessions = await pool.query(`
    SELECT user_id, target_type, target_id, item_index, field, status,
           chat_id, message_id, language, expires_at, late_input_consumed_at
    FROM telegram_input_sessions WHERE false
  `);
  assert.equal(sessions.fields.length, 11);

  const sessionConstraint = await pool.query(`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'telegram_input_sessions'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status%'
  `);
  assert.ok(sessionConstraint.rows.some((row) => row.definition.includes("processing")));
  const busyIndex = await pool.query(`
    SELECT indexdef
    FROM pg_indexes
    WHERE tablename = 'telegram_input_sessions'
      AND indexname = 'telegram_input_sessions_one_busy_user_idx'
  `);
  assert.match(busyIndex.rows[0]?.indexdef ?? "", /processing/);

  const expenses = await pool.query("SELECT updated_at FROM expenses WHERE false");
  assert.equal(expenses.fields.length, 1);
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

test("enforces singleton onboarding events without limiting repeatable events", async () => {
  const user = await createSmokeUser(990010);

  assert.deepEqual(
    await repo.recordAppEventOnce(user.id, "onboarding_started"),
    { recorded: true }
  );
  assert.deepEqual(
    await repo.recordAppEventOnce(user.id, "onboarding_started"),
    { recorded: false }
  );
  assert.deepEqual(
    await repo.recordAppEventOnce(user.id, "currency_selected", { currency: "THB" }),
    { recorded: true }
  );
  await repo.recordAppEvent(user.id, "bot_started", { source: "direct" });
  await repo.recordAppEvent(user.id, "bot_started", { source: "direct" });

  const events = await pool.query(
    "SELECT event_name, COUNT(*)::int AS count FROM app_events WHERE user_id = $1 GROUP BY event_name ORDER BY event_name",
    [user.id]
  );
  assert.deepEqual(events.rows, [
    { event_name: "bot_started", count: 2 },
    { event_name: "currency_selected", count: 1 },
    { event_name: "onboarding_started", count: 1 }
  ]);
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

test("Quick Access token status and concurrent request idempotency are durable", async () => {
  const user = await createSmokeUser(990014);
  const token = await repo.createQuickAccessToken(user.id, "smoke-token-hash");
  assert.deepEqual(await repo.getQuickAccessStatus(user.id), { configured: true, lastUsedAt: null });
  const firstClaim = await repo.claimShortcutRequest(token.id, user.id, "durable-race-request");
  const competingClaim = await repo.claimShortcutRequest(token.id, user.id, "durable-race-request");
  assert.equal(firstClaim.state, "claimed");
  assert.equal(competingClaim.state, "processing");
  const created = await repo.completeShortcutRequest({
    tokenId: token.id, userId: user.id, clientRequestId: "durable-race-request", sourceText: "coffee 120",
    items: [expenseItem({ description: "durable race coffee", amount: 120 })]
  });
  const replay = await repo.waitForShortcutRequest(token.id, user.id, "durable-race-request");
  assert.equal(replay.state, "completed");
  assert.equal(replay.draft.id, created.draft.id);
  let parserCalls = 0;
  const expenseParser = { parse: async () => {
    parserCalls += 1;
    return { expenses: [expenseItem({ description: "shortcut coffee", amount: 120 })] };
  } };
  const [first, second] = await Promise.all([
    createShortcutExpenseDraft({ user, tokenId: token.id, clientRequestId: "shortcut-request-1", text: "coffee 120", expenseParser, repository: repo }),
    createShortcutExpenseDraft({ user, tokenId: token.id, clientRequestId: "shortcut-request-1", text: "coffee 120", expenseParser, repository: repo })
  ]);
  assert.equal(parserCalls, 1);
  assert.equal(first.draft.id, second.draft.id);
  assert.deepEqual([first.replayed, second.replayed].sort(), [false, true]);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM drafts WHERE user_id = $1", [user.id])).rows[0].count, 2);
  const otherUser = await createSmokeUser(990015);
  assert.equal(await repo.claimShortcutRequest(token.id, otherUser.id, "foreign-request"), null);
  assert.equal(await repo.revokeQuickAccessTokens(user.id), true);
  assert.equal(await repo.findQuickAccessToken("smoke-token-hash"), null);
  assert.deepEqual(await repo.getQuickAccessStatus(user.id), { configured: false, lastUsedAt: null });
});

test("saves feedback with source metadata", async () => {
  const user = await createSmokeUser(990008);

  const feedback = await repo.createFeedback({
    userId: user.id,
    telegramUserId: 990008,
    message: "Please make category editing clearer",
    source: "bot"
  });

  assert.equal(feedback.user_id, user.id.toString());
  assert.equal(feedback.telegram_user_id, "990008");
  assert.equal(feedback.message, "Please make category editing clearer");
  assert.equal(feedback.status, "new");
  assert.equal(feedback.source, "bot");

  const stored = await pool.query("SELECT * FROM feedback WHERE id = $1", [feedback.id]);
  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].source, "bot");
  assert.equal(stored.rows[0].status, "new");
});

test("deletes user-owned data and leaves only a safe audit event", async () => {
  const telegramUserId = 990009;
  const now = new Date("2026-07-09T10:00:00.000Z");
  const user = await createSmokeUser(telegramUserId);

  await repo.recordAppEvent(user.id, "message_received", { source_text: "coffee 120" });
  await repo.createFeedback({
    userId: user.id,
    telegramUserId,
    message: "Delete this feedback too",
    source: "miniapp"
  });
  const releaseNote = await pool.query(
    `INSERT INTO release_notes (version, title_ru, body_ru)
     VALUES ('v.1.990009', 'Smoke', 'Smoke')
     RETURNING id`
  );
  await pool.query(
    "INSERT INTO release_note_deliveries (release_note_id, user_id) VALUES ($1, $2)",
    [releaseNote.rows[0].id, user.id]
  );
  await pool.query(
    `INSERT INTO exchange_rates (rate_date, base_currency, quote_currency, rate, provider)
     VALUES ('2026-07-09', 'USD', 'THB', 32.65, 'smoke')`
  );

  await repo.requestAccountDeletion(telegramUserId, { source: "miniapp", now });
  await repo.advanceAccountDeletion(telegramUserId, { source: "miniapp", now });
  const result = await repo.confirmAccountDeletion({
    telegramUserId,
    source: "miniapp",
    confirmationText: "DELETE",
    now
  });

  assert.deepEqual(result, { status: "deleted" });
  assert.equal(await repo.getUserByTelegramId(telegramUserId), null);
  assert.equal((await pool.query("SELECT * FROM feedback WHERE telegram_user_id = $1", [telegramUserId])).rowCount, 0);
  assert.equal((await pool.query("SELECT * FROM release_note_deliveries WHERE user_id = $1", [user.id])).rowCount, 0);
  assert.equal((await pool.query("SELECT * FROM account_deletion_requests WHERE user_id = $1", [user.id])).rowCount, 0);

  const events = await pool.query("SELECT user_id, event_name, metadata FROM app_events ORDER BY id");
  assert.deepEqual(events.rows, [{ user_id: null, event_name: "account_deleted", metadata: { source: "miniapp" } }]);
  assert.equal((await pool.query("SELECT * FROM exchange_rates WHERE provider = 'smoke'")).rowCount, 1);
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

test("archives and recreates a partially paid weekly plan without rewriting history or today's snapshot", async () => {
  const now = new Date("2026-07-22T10:00:00+07:00");
  await createSmokeUser(990004);
  const planned = await repo.createPlannedExpense(990004, {
    amount: 1000,
    currency: "THB",
    description: "weekly lesson",
    category_slug: "home",
    recurrence: "weekly",
    weekday: 3,
    tags: ["fixed"]
  }, new Date("2026-07-01T00:00:00+07:00"));

  assert.equal(Number(planned.amount_base), 1000);
  assert.equal(planned.disabled_at, null);

  let plannedRows = await repo.listPlannedExpensesForTelegramUser(990004, now);
  assert.equal(plannedRows.length, 1);
  assert.equal(plannedRows[0].description, "weekly lesson");

  const firstPaid = await repo.payPlannedExpenseForTelegramUser(
    planned.id,
    990004,
    new Date("2026-07-01T10:00:00+07:00"),
    { occurrenceDate: "2026-07-01" }
  );
  const secondPaid = await repo.payPlannedExpenseForTelegramUser(
    planned.id,
    990004,
    new Date("2026-07-08T10:00:00+07:00"),
    { occurrenceDate: "2026-07-08" }
  );
  assert.equal(firstPaid.budget_impact, "planned");
  assert.equal(secondPaid.budget_impact, "planned");

  plannedRows = await repo.listPlannedExpensesForTelegramUser(990004, now);
  assert.equal(plannedRows[0].paid_count, 2);
  assert.deepEqual(plannedRows[0].paid_occurrence_dates, ["2026-07-01", "2026-07-08"]);

  const beforeDisableDashboard = await repo.dashboard(990004, now);
  assert.equal(beforeDisableDashboard.snapshot.plannedRemaining, 3000);
  assert.equal(beforeDisableDashboard.snapshot.freeRemaining, 40000);
  assert.equal(beforeDisableDashboard.snapshot.forecastMonthTotal, 5000);
  const beforeRows = {
    expenses: Number((await pool.query("SELECT COUNT(*)::int AS count FROM expenses WHERE user_id = $1", [planned.user_id])).rows[0].count),
    payments: Number((await pool.query("SELECT COUNT(*)::int AS count FROM planned_expense_payments WHERE planned_expense_id = $1", [planned.id])).rows[0].count)
  };

  const firstDisable = await repo.deactivatePlannedExpense(990004, planned.id, now);
  const secondDisable = await repo.deactivatePlannedExpense(990004, planned.id, new Date("2026-07-22T12:00:00+07:00"));

  assert.deepEqual(firstDisable.impact, {
    paidOccurrencesKept: 2,
    paidAmountKept: 2000,
    unpaidOccurrencesRemoved: 3,
    unpaidAmountRemoved: 3000,
    currency: "THB"
  });
  assert.deepEqual(secondDisable, firstDisable);
  assert.equal(firstDisable.plannedExpense.active, false);
  assert.equal(firstDisable.plannedExpense.disabled_at.toISOString(), now.toISOString());

  plannedRows = await repo.listPlannedExpensesForTelegramUser(990004, now);
  assert.equal(plannedRows.length, 0);

  const storedPlan = await pool.query("SELECT active, disabled_at FROM planned_expenses WHERE id = $1", [planned.id]);
  assert.equal(storedPlan.rows[0].active, false);
  assert.equal(storedPlan.rows[0].disabled_at.toISOString(), now.toISOString());
  assert.deepEqual({
    expenses: Number((await pool.query("SELECT COUNT(*)::int AS count FROM expenses WHERE user_id = $1", [planned.user_id])).rows[0].count),
    payments: Number((await pool.query("SELECT COUNT(*)::int AS count FROM planned_expense_payments WHERE planned_expense_id = $1", [planned.id])).rows[0].count)
  }, beforeRows);

  const afterDisableDashboard = await repo.dashboard(990004, now);
  assert.equal(afterDisableDashboard.snapshot.dayPlanLimit, beforeDisableDashboard.snapshot.dayPlanLimit);
  assert.equal(afterDisableDashboard.snapshot.plannedRemaining, 0);
  assert.equal(afterDisableDashboard.snapshot.freeRemaining, 43000);
  assert.equal(afterDisableDashboard.snapshot.forecastMonthTotal, 2000);

  const archived = await repo.listArchivedPlannedExpensesForTelegramUser(990004);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].id, planned.id);
  assert.equal(archived[0].active, false);
  assert.equal(archived[0].disabled_at.toISOString(), now.toISOString());
  assert.equal(archived[0].paid_count, 2);
  assert.equal(archived[0].paid_amount_base, 2000);

  await repo.upsertCurrentReserve(990004, {
    amount: 42000,
    title: "buffer",
    scope: "current"
  }, now);
  const beforeRecreateDashboard = await repo.dashboard(990004, now);
  assert.equal(beforeRecreateDashboard.snapshot.plannedRemaining, 0);

  const recreated = await repo.recreatePlannedExpense(990004, planned.id, {
    amount: 1000,
    currency: "THB",
    description: "weekly lesson restarted",
    category_slug: "home",
    recurrence: "weekly",
    weekday: 3,
    tags: ["fixed"]
  }, "2026-07-23", now);
  assert.notEqual(recreated.id, planned.id);
  assert.equal(recreated.active, true);
  assert.equal(normalizePlannedDateKey(recreated.starts_on), "2026-07-23");

  const activeAfterRecreate = await repo.listPlannedExpensesForTelegramUser(990004, now);
  assert.equal(activeAfterRecreate.length, 1);
  assert.equal(activeAfterRecreate[0].id, recreated.id);
  assert.equal(activeAfterRecreate[0].paid_count, 0);
  assert.deepEqual(activeAfterRecreate[0].paid_occurrence_dates, []);
  assert.equal((await pool.query(
    "SELECT COUNT(*)::int AS count FROM planned_expense_payments WHERE planned_expense_id = $1",
    [recreated.id]
  )).rows[0].count, 0);
  assert.deepEqual({
    expenses: Number((await pool.query("SELECT COUNT(*)::int AS count FROM expenses WHERE user_id = $1", [planned.user_id])).rows[0].count),
    sourcePayments: Number((await pool.query("SELECT COUNT(*)::int AS count FROM planned_expense_payments WHERE planned_expense_id = $1", [planned.id])).rows[0].count)
  }, { expenses: beforeRows.expenses, sourcePayments: beforeRows.payments });

  const sourceAfterRecreate = await repo.listArchivedPlannedExpensesForTelegramUser(990004);
  assert.equal(sourceAfterRecreate.length, 1);
  assert.equal(sourceAfterRecreate[0].id, planned.id);
  assert.equal(sourceAfterRecreate[0].disabled_at.toISOString(), now.toISOString());
  assert.equal(sourceAfterRecreate[0].paid_count, 2);
  assert.equal(sourceAfterRecreate[0].paid_amount_base, 2000);

  const afterRecreateDashboard = await repo.dashboard(990004, now);
  assert.equal(afterRecreateDashboard.plannedMonthSummary.remaining, 1000);
  assert.equal(afterRecreateDashboard.snapshot.plannedRemaining, 1000);
  assert.equal(afterRecreateDashboard.snapshot.forecastMonthTotal, 3000);
  assert.equal(afterRecreateDashboard.snapshot.dayPlanLimit, beforeRecreateDashboard.snapshot.dayPlanLimit);

  const nextDayDashboard = await repo.dashboard(990004, new Date("2026-07-23T10:00:00+07:00"));
  assert.equal(nextDayDashboard.snapshot.plannedRemaining, 1000);
  assert.equal(nextDayDashboard.snapshot.dayPlanLimit, 0);
  assert.ok(nextDayDashboard.snapshot.dayPlanLimit < afterRecreateDashboard.snapshot.dayPlanLimit);
  const dailySnapshots = await pool.query(
    `SELECT day_key::text, budget_amount_base
     FROM daily_budget_snapshots
     WHERE user_id = $1
     ORDER BY day_key`,
    [planned.user_id]
  );
  assert.deepEqual(dailySnapshots.rows.map((row) => row.day_key), ["2026-07-22", "2026-07-23"]);
  assert.equal(Number(dailySnapshots.rows[0].budget_amount_base), beforeRecreateDashboard.snapshot.dayPlanLimit);
  assert.equal(Number(dailySnapshots.rows[1].budget_amount_base), nextDayDashboard.snapshot.dayPlanLimit);
  assert.equal((await pool.query(
    "SELECT COUNT(*)::int AS count FROM app_events WHERE user_id = $1 AND event_name = 'planned_expense_deleted'",
    [planned.user_id]
  )).rows[0].count, 1);
});

test("persists idempotent planned reminder delivery, snooze, pay, and disable state", async () => {
  const telegramUserId = 990013;
  const user = await createSmokeUser(telegramUserId);
  const planned = await repo.createPlannedExpense(telegramUserId, {
    amount: 1000,
    currency: "THB",
    description: "reminder smoke",
    category_slug: "education",
    recurrence: "monthly",
    due_day: 27
  }, new Date("2026-07-01T00:00:00+07:00"));
  await pool.query(
    "UPDATE users SET onboarding_step = 'completed' WHERE id = $1",
    [user.id]
  );

  const candidates = await repo.listPlannedPaymentReminderCandidates();
  assert.equal(candidates.some((candidate) => candidate.id === planned.id), true);

  const claim = {
    userId: user.id,
    plannedExpenseId: planned.id,
    occurrenceDate: "2026-07-27",
    localDate: "2026-07-27",
    timezoneUsed: "Asia/Bangkok"
  };
  assert.ok(await repo.claimPlannedPaymentReminder(claim));
  assert.equal(await repo.claimPlannedPaymentReminder(claim), null);
  assert.ok(await repo.releasePlannedPaymentReminderClaim({
    ...claim,
    previousLastSentLocalDate: null,
    previousNextReminderLocalDate: null
  }));
  assert.ok(await repo.claimPlannedPaymentReminder(claim));
  assert.equal(await repo.claimPlannedPaymentReminder(claim), null);
  await repo.recordPlannedPaymentReminderMessage({
    ...claim,
    telegramChatId: telegramUserId,
    telegramMessageId: 77,
    sentAt: new Date("2026-07-27T14:00:00Z")
  });
  assert.ok(await repo.snoozePlannedPaymentReminderForTelegramUser(
    planned.id,
    telegramUserId,
    "2026-07-27",
    "2026-07-28",
    "Asia/Bangkok"
  ));
  assert.ok(await repo.claimPlannedPaymentReminder({ ...claim, localDate: "2026-07-28" }));
  const secondClaim = {
    ...claim,
    occurrenceDate: "2026-08-27",
    localDate: "2026-08-27"
  };
  assert.ok(await repo.claimPlannedPaymentReminder(secondClaim));
  await repo.recordPlannedPaymentReminderMessage({
    ...secondClaim,
    telegramChatId: telegramUserId,
    telegramMessageId: 78,
    sentAt: new Date("2026-08-27T14:00:00Z")
  });
  assert.equal((await repo.listOutstandingPlannedPaymentReminders(planned.id)).length, 2);

  const paid = await repo.payPlannedExpenseForTelegramUser(
    planned.id,
    telegramUserId,
    new Date("2026-07-28T14:00:00+07:00"),
    { occurrenceDate: "2026-07-27" }
  );
  assert.equal(paid.budget_impact, "planned");
  const afterPay = await repo.listPlannedPaymentReminderCandidates();
  assert.deepEqual(
    afterPay.find((candidate) => candidate.id === planned.id).paid_occurrence_dates,
    ["2026-07-27"]
  );

  const disabled = await repo.deactivatePlannedExpense(
    telegramUserId,
    planned.id,
    new Date("2026-07-28T15:00:00+07:00")
  );
  assert.equal(disabled.plannedExpense.active, false);
  const disabledReminders = await repo.markAllPlannedPaymentRemindersTerminal(planned.id, "disabled");
  assert.equal(disabledReminders.length, 2);
  assert.equal(disabledReminders.every((reminder) => reminder.status === "disabled"), true);
  assert.equal((await repo.listOutstandingPlannedPaymentReminders(planned.id)).length, 0);
  assert.equal(
    (await repo.listPlannedPaymentReminderCandidates()).some((candidate) => candidate.id === planned.id),
    false
  );
});

test("undoes one exact planned payment without changing today's opening snapshot", async () => {
  const telegramUserId = 990010;
  const user = await createSmokeUser(telegramUserId);
  const planned = await repo.createPlannedExpense(telegramUserId, {
    amount: 1000,
    currency: "THB",
    description: "weekly undo smoke",
    category_slug: "home",
    recurrence: "weekly",
    weekday: 3
  }, new Date("2026-07-01T00:00:00+07:00"));

  await repo.payPlannedExpenseForTelegramUser(planned.id, telegramUserId, new Date("2026-07-01T10:00:00+07:00"), { occurrenceDate: "2026-07-01" });
  await repo.payPlannedExpenseForTelegramUser(planned.id, telegramUserId, new Date("2026-07-08T10:00:00+07:00"), { occurrenceDate: "2026-07-08" });
  const now = new Date("2026-07-22T10:00:00+07:00");
  const before = await repo.dashboard(telegramUserId, now);
  const snapshotBefore = await pool.query(
    "SELECT day_key::text, budget_amount_base FROM daily_budget_snapshots WHERE user_id = $1",
    [user.id]
  );

  const undone = await repo.undoPlannedExpensePaymentForTelegramUser(planned.id, telegramUserId, "2026-07-08", now);
  const repeated = await repo.undoPlannedExpensePaymentForTelegramUser(planned.id, telegramUserId, "2026-07-08", now);
  assert.deepEqual(undone, { status: "undone", occurrenceDate: "2026-07-08" });
  assert.deepEqual(repeated, { status: "already_unpaid", occurrenceDate: "2026-07-08" });
  assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM planned_expense_payments WHERE planned_expense_id = $1", [planned.id])).rows[0].count), 1);
  assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM expenses WHERE user_id = $1", [user.id])).rows[0].count), 1);

  const after = await repo.dashboard(telegramUserId, now);
  assert.equal(after.plannedMonthSummary.paid, 1000);
  assert.equal(after.plannedMonthSummary.remaining, 4000);
  assert.equal(after.snapshot.dayPlanLimit, before.snapshot.dayPlanLimit);
  const snapshotAfter = await pool.query(
    "SELECT day_key::text, budget_amount_base FROM daily_budget_snapshots WHERE user_id = $1",
    [user.id]
  );
  assert.deepEqual(snapshotAfter.rows, snapshotBefore.rows);

  await pool.query(
    `INSERT INTO monthly_reserve_instances (
       user_id, period, timezone, currency, budget_amount, reserve_amount, status, closed_at
     ) VALUES ($1, '2026-07', 'Asia/Bangkok', 'THB', 45000, 1000, 'closed', now())`,
    [user.id]
  );
  await assert.rejects(
    () => repo.undoPlannedExpensePaymentForTelegramUser(planned.id, telegramUserId, "2026-07-01", now),
    { code: "planned_payment_undo_blocked" }
  );
  assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM planned_expense_payments WHERE planned_expense_id = $1", [planned.id])).rows[0].count), 1);
  assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS count FROM expenses WHERE user_id = $1", [user.id])).rows[0].count), 1);
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

test("allows metadata-only correction but blocks financial changes in a closed reserve month", async () => {
  const telegramUserId = 990009;
  const user = await createSmokeUser(telegramUserId);
  const expense = await saveExpense(user.id, telegramUserId, {
    amount: 100,
    description: "old name",
    category_slug: "food_cafe",
    spent_at: "2026-06-15T05:00:00.000Z"
  });
  await pool.query(
    `INSERT INTO monthly_reserve_instances (
       user_id, period, timezone, currency, budget_amount, reserve_amount, status, closed_at
     ) VALUES ($1, '2026-06', 'Asia/Bangkok', 'THB', 45000, 1000, 'closed', now())`,
    [user.id]
  );

  const metadata = await repo.updateExpenseForTelegramUser(
    expense.id,
    telegramUserId,
    { description: "corrected name", category_slug: "home", tags: ["fixed"] },
    new Date("2026-07-15T12:00:00.000Z")
  );
  assert.equal(metadata.description, "corrected name");
  assert.equal(metadata.category_slug, "home");
  assert.deepEqual(metadata.tags, ["fixed"]);

  await assert.rejects(
    () => repo.updateExpenseForTelegramUser(expense.id, telegramUserId, { amount: 200 }, new Date("2026-07-15T12:00:00.000Z")),
    { code: "expense_source_month_closed" }
  );
  await assert.rejects(
    () => repo.deleteExpenseForTelegramUser(expense.id, telegramUserId, new Date("2026-07-15T12:00:00.000Z")),
    { code: "expense_delete_blocked" }
  );
});

test("consumes Telegram input sessions atomically and preserves an active session after rollback", async () => {
  const telegramUserId = 990008;
  const user = await createSmokeUser(telegramUserId);
  const now = new Date("2026-07-15T12:00:00.000Z");
  const input = {
    targetType: "draft",
    targetId: 999,
    itemIndex: 0,
    field: "description",
    chatId: telegramUserId,
    messageId: 11,
    language: "en"
  };
  const started = await repo.startTelegramInputSession(telegramUserId, input, now);
  assert.equal(started.outcome, "started");

  const completed = await repo.consumeTelegramInputSession(telegramUserId, {
    sessionId: started.session.id,
    now,
    async apply({ client }) {
      await client.query("UPDATE users SET first_name = $2 WHERE id = $1", [user.id, "Updated"]);
    }
  });
  assert.equal(completed.outcome, "completed");

  const afterCommit = await pool.query("SELECT first_name FROM users WHERE id = $1", [user.id]);
  assert.equal(afterCommit.rows[0].first_name, "Updated");
  const completedSession = await pool.query(
    "SELECT status FROM telegram_input_sessions WHERE id = $1",
    [started.session.id]
  );
  assert.equal(completedSession.rows[0].status, "completed");
  assert.equal(await repo.getRoutableTelegramInputSession(telegramUserId), null);

  const second = await repo.startTelegramInputSession(telegramUserId, { ...input, messageId: 12 }, now);
  await assert.rejects(
    () => repo.consumeTelegramInputSession(telegramUserId, {
      sessionId: second.session.id,
      now,
      async apply({ client }) {
        await client.query("UPDATE users SET first_name = $2 WHERE id = $1", [user.id, "Must rollback"]);
        throw Object.assign(new Error("invalid description"), { code: "expense_invalid_description" });
      }
    }),
    { code: "expense_invalid_description" }
  );
  const afterRollback = await pool.query("SELECT first_name FROM users WHERE id = $1", [user.id]);
  assert.equal(afterRollback.rows[0].first_name, "Updated");
  const activeSession = await pool.query(
    "SELECT status FROM telegram_input_sessions WHERE id = $1",
    [second.session.id]
  );
  assert.equal(activeSession.rows[0].status, "active");

  const promptStored = await repo.setTelegramInputSessionPrompt(telegramUserId, second.session.id, {
    targetType: "draft", targetId: 999, itemIndex: 0, promptMessageId: 99
  }, now);
  assert.equal(promptStored.outcome, "stored");
  const closed = await repo.closeTelegramInputSessionForTarget(telegramUserId, {
    targetType: "draft", targetId: 999, itemIndex: 0
  }, now);
  assert.equal(closed.outcome, "cancelled");
  assert.equal(Number(closed.session.prompt_message_id), 99);
  assert.equal(await repo.getRoutableTelegramInputSession(telegramUserId), null);

  const concurrent = await repo.startTelegramInputSession(telegramUserId, { ...input, messageId: 13 }, now);
  let applyCount = 0;
  const outcomes = await Promise.all([
    repo.consumeTelegramInputSession(telegramUserId, {
      sessionId: concurrent.session.id,
      now,
      async apply() { applyCount += 1; }
    }),
    repo.consumeTelegramInputSession(telegramUserId, {
      sessionId: concurrent.session.id,
      now,
      async apply() { applyCount += 1; }
    })
  ]);
  assert.equal(applyCount, 1);
  assert.deepEqual(outcomes.map((result) => result.outcome).sort(), ["already_consumed", "completed"]);
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
