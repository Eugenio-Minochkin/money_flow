import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { migrate } from "../src/db.js";
import { normalizePlannedDateKey } from "../src/plannedOccurrenceDates.js";
import { createRepository } from "../src/repository.js";
import { createMiniAppQuickCaptureDraft, createShortcutExpenseDraft, createTelegramExpenseDraft } from "../src/expenseDraftService.js";
import { processMiniAppQuickCapture } from "../src/quickCapture.js";
import { processShortcutCapture } from "../src/shortcutCapture.js";
import { acceptReviewRecovery, previewSmartSaveRecovery, saveSmartSaveRecovery } from "../src/smartSaveRecovery.js";

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
    ["001_initial.sql", "002_draft_confirm_flow.sql", "003_budget_topups.sql", "004_report_deliveries.sql", "005_exchange_rates.sql", "006_feedback.sql", "007_account_deletion.sql", "008_product_analytics.sql", "009_telegram_expense_editor.sql", "010_telegram_editor_prompt_message.sql", "011_planned_expense_disabled_at.sql", "012_planned_expense_starts_on.sql", "013_planned_payment_reminders.sql", "014_quick_access_tokens.sql", "015_quick_capture_safety.sql", "016_quick_access_token_single_active.sql", "017_telegram_expense_capture_safety.sql", "018_display_currency_follows_base.sql", "019_paid_provider_usage.sql", "020_expense_evidence_imports.sql", "021_expense_evidence_sessions.sql", "022_telegram_capture_inbox.sql", "023_telegram_capture_terminal_failures.sql"]
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

test("reserves paid-provider usage once for the same durable request key", async () => {
  const user = await createSmokeUser(990201);
  const input = {
    userId: user.id,
    provider: "deepgram_transcription",
    windowMs: 86_400_000,
    maxRequests: 50,
    maxAudioSeconds: 900,
    audioSeconds: 42,
    requestKey: "telegram:990201:880201:77"
  };

  assert.deepEqual(await repo.reservePaidProviderUsage(input), { allowed: true });
  assert.deepEqual(await repo.reservePaidProviderUsage(input), { allowed: true, replayed: true });

  const stored = await pool.query(
    "SELECT request_count, audio_seconds FROM paid_provider_usage_windows WHERE user_id = $1 AND provider = $2",
    [user.id, input.provider]
  );
  assert.deepEqual(stored.rows, [{ request_count: 1, audio_seconds: 42 }]);
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
  const token = await repo.prepareQuickAccessToken(user.id, "smoke-token-hash");
  assert.deepEqual(await repo.getQuickAccessStatus(user.id), { configured: false, lastUsedAt: null });
  assert.deepEqual(
    await repo.activatePreparedQuickAccessToken(user.id, token.id),
    { state: "activated" }
  );
  assert.deepEqual(await repo.getQuickAccessStatus(user.id), { configured: true, lastUsedAt: null });
  const firstClaim = await repo.claimShortcutRequest(token.id, user.id, "durable-race-request");
  const competingClaim = await repo.claimShortcutRequest(token.id, user.id, "durable-race-request");
  assert.equal(firstClaim.state, "claimed");
  assert.equal(competingClaim.state, "processing");
  const created = await repo.completeShortcutRequest({
    tokenId: token.id, userId: user.id, clientRequestId: "durable-race-request", claimVersion: firstClaim.claimVersion, sourceText: "coffee 120",
    items: [expenseItem({ description: "durable race coffee", amount: 120 })]
  });
  const replay = await repo.waitForShortcutRequest(token.id, user.id, "durable-race-request");
  assert.equal(replay.state, "completed");
  assert.equal(replay.draft.id, created.draft.id);
  const staleClaim = await repo.claimShortcutRequest(token.id, user.id, "stale-claim-request");
  await pool.query(
    "UPDATE quick_access_requests SET lease_expires_at = now() - interval '1 second' WHERE token_id = $1 AND client_request_id = $2",
    [token.id, "stale-claim-request"]
  );
  const reclaimedClaim = await repo.claimShortcutRequest(token.id, user.id, "stale-claim-request");
  assert.equal(reclaimedClaim.state, "claimed");
  assert.notEqual(reclaimedClaim.claimVersion, staleClaim.claimVersion);
  assert.equal(await repo.completeShortcutRequest({
    tokenId: token.id, userId: user.id, clientRequestId: "stale-claim-request", claimVersion: staleClaim.claimVersion, sourceText: "coffee 120",
    items: [expenseItem({ description: "stale worker coffee", amount: 120 })]
  }), null);
  const reclaimedDraft = await repo.completeShortcutRequest({
    tokenId: token.id, userId: user.id, clientRequestId: "stale-claim-request", claimVersion: reclaimedClaim.claimVersion, sourceText: "coffee 120",
    items: [expenseItem({ description: "reclaimed coffee", amount: 120 })]
  });
  assert.ok(reclaimedDraft?.draft?.id);
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
  assert.deepEqual([first.replayed, second.replayed], [false, false]);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM drafts WHERE user_id = $1", [user.id])).rows[0].count, 3);
  const otherUser = await createSmokeUser(990015);
  assert.equal(await repo.claimShortcutRequest(token.id, otherUser.id, "foreign-request"), null);
  assert.equal(await repo.revokeQuickAccessTokens(user.id), true);
  assert.equal(await repo.findQuickAccessToken("smoke-token-hash"), null);
  assert.deepEqual(await repo.getQuickAccessStatus(user.id), { configured: false, lastUsedAt: null });
});

test("Shortcut Smart Save survives concurrent and lost-response replay with one financial fact", async () => {
  const user = await createSmokeUser(990019);
  const token = await repo.prepareQuickAccessToken(user.id, "smart-save-shortcut-token-hash");
  assert.deepEqual(await repo.activatePreparedQuickAccessToken(user.id, token.id), { state: "activated" });
  let parserCalls = 0;
  const input = {
    user,
    tokenId: token.id,
    clientRequestId: "shortcut-smart-save-replay",
    text: "coffee 180",
    expenseParser: { parse: async () => {
      parserCalls += 1;
      return { expenses: [expenseItem({ description: "shortcut coffee", amount: 180 })] };
    } },
    repository: repo,
    now: new Date("2026-06-24T12:00:00.000Z")
  };

  const concurrent = await Promise.all([
    processShortcutCapture(input),
    processShortcutCapture(input)
  ]);
  const replay = await processShortcutCapture(input);

  assert.equal(parserCalls, 1);
  assert.deepEqual([...concurrent, replay].map((result) => result.state), ["saved", "saved", "saved"]);
  assert.equal(new Set([...concurrent, replay].map((result) => String(result.expense.id))).size, 1);
  assert.equal(replay.replayed, true);
  assert.equal(replay.alreadySaved, true);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM drafts WHERE user_id = $1", [user.id])).rows[0].count, 1);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM expenses WHERE user_id = $1", [user.id])).rows[0].count, 1);
});

test("concurrent Quick Access activations leave only the final key active", async () => {
  const user = await createSmokeUser(990017);
  const first = await repo.prepareQuickAccessToken(user.id, "concurrent-first-token-hash");
  const second = await repo.prepareQuickAccessToken(user.id, "concurrent-second-token-hash");

  const results = await Promise.all([
    repo.activatePreparedQuickAccessToken(user.id, first.id),
    repo.activatePreparedQuickAccessToken(user.id, second.id)
  ]);
  assert.deepEqual(results.map((result) => result.state).sort(), ["activated", "activated"]);
  const active = await pool.query(
    `SELECT id, token_hash FROM quick_access_tokens
     WHERE user_id = $1 AND activated_at IS NOT NULL AND revoked_at IS NULL`,
    [user.id]
  );
  assert.equal(active.rowCount, 1);
  assert.ok(await repo.findQuickAccessToken(active.rows[0].token_hash));
  const inactiveHash = active.rows[0].token_hash === "concurrent-first-token-hash"
    ? "concurrent-second-token-hash"
    : "concurrent-first-token-hash";
  assert.equal(await repo.findQuickAccessToken(inactiveHash), null);
});

test("Mini App Quick Capture keeps one durable draft and expense across concurrent replays", async () => {
  const user = await createSmokeUser(990016);
  let parserCalls = 0;
  const expenseParser = { parse: async () => {
    parserCalls += 1;
    return { expenses: [expenseItem({ description: "quick capture coffee", amount: 120, category_source: "parser" })] };
  } };
  const request = {
    user,
    clientRequestId: "mini-app-safe-replay-0001",
    text: "coffee 120",
    expenseParser,
    repository: repo
  };
  const [first, second] = await Promise.all([
    processMiniAppQuickCapture(request),
    processMiniAppQuickCapture(request)
  ]);
  assert.equal(parserCalls, 1);
  assert.equal(first.saved.expenses[0].id, second.saved.expenses[0].id);
  assert.equal(
    (await pool.query("SELECT COUNT(*)::int AS count FROM expenses WHERE user_id = $1", [user.id])).rows[0].count,
    1
  );

  const reviewParser = { parse: async () => ({
    expenses: [expenseItem({ description: "uncertain capture", category_slug: "other", category_source: "parser", needs_review: true })]
  }) };
  const review = await createMiniAppQuickCaptureDraft({
    user,
    clientRequestId: "mini-app-review-replay-0001",
    text: "something uncertain",
    expenseParser: reviewParser,
    repository: repo
  });
  const reviewReplay = await createMiniAppQuickCaptureDraft({
    user,
    clientRequestId: "mini-app-review-replay-0001",
    text: "something uncertain",
    expenseParser: { parse: async () => { throw new Error("parser must not run on replay"); } },
    repository: repo
  });
  assert.equal(review.draft.id, reviewReplay.draft.id);
  assert.equal(reviewReplay.replayed, true);
  assert.equal(reviewReplay.draft.items[0].category_source, "parser");
});

test("Smart Save replays Telegram delivery and safely recovers every unresolved draft", async () => {
  const telegramUserId = 990018;
  const user = await createSmokeUser(telegramUserId);
  let parserCalls = 0;
  const expenseParser = { parse: async () => {
    parserCalls += 1;
    return { expenses: [expenseItem({ description: "telegram coffee", amount: 125, category_source: "parser", spent_at: "2026-08-14T05:00:00.000Z" })] };
  } };
  const capture = { user, chatId: 880018, messageId: 77, text: "coffee 125", expenseParser, repository: repo };
  const [first, second] = await Promise.all([
    createTelegramExpenseDraft(capture),
    createTelegramExpenseDraft(capture)
  ]);
  assert.equal(parserCalls, 1);
  assert.equal(first.draft.id, second.draft.id);
  assert.deepEqual([first.replayed, second.replayed], [false, true]);

  const ambiguous = await repo.createDraft(user.id, "unclear 80", [
    expenseItem({ description: "unclear", amount: 80, category_slug: "other", category_source: "parser", needs_review: true, spent_at: "2026-08-14T06:00:00.000Z" })
  ]);
  const closed = await repo.createDraft(user.id, "old coffee 90", [
    expenseItem({ description: "old coffee", amount: 90, category_source: "parser", spent_at: "2026-07-10T05:00:00.000Z" })
  ]);
  await pool.query(
    `INSERT INTO monthly_reserve_instances
       (user_id, period, timezone, currency, budget_amount, reserve_amount, status, closed_at)
     VALUES ($1, '2026-07', 'Asia/Bangkok', 'THB', 45000, 1000, 'closed', now())`,
    [user.id]
  );

  const now = new Date("2026-08-14T12:00:00.000Z");
  const preview = await previewSmartSaveRecovery({ telegramUserId, repository: repo, now });
  assert.deepEqual(
    { total: preview.totalUnresolved, safe: preview.safeCount, review: preview.reviewCount },
    { total: 3, safe: 1, review: 2 }
  );
  const [direct, saved] = await Promise.all([
    repo.saveDraftAsExpense(first.draft.id, telegramUserId),
    saveSmartSaveRecovery({
      telegramUserId,
      draftIds: [first.draft.id, ambiguous.id, closed.id],
      repository: repo,
      now
    })
  ]);
  assert.ok([true, false].includes(direct.alreadySaved));
  assert.ok(["saved", "already_saved"].includes(saved.results[0].state));
  assert.deepEqual(saved.results.slice(1).map((item) => item.state), ["review", "review"]);
  const retry = await saveSmartSaveRecovery({ telegramUserId, draftIds: [first.draft.id], repository: repo, now });
  assert.equal(retry.results[0].state, "already_saved");
  const stored = await pool.query("SELECT spent_at FROM expenses WHERE user_id = $1", [user.id]);
  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].spent_at.toISOString(), "2026-08-14T05:00:00.000Z");
});

test("persists ambiguous currency review without a default and saves only after an allowed choice", async () => {
  const telegramUserId = 990041;
  const user = await createSmokeUser(telegramUserId);
  const ambiguousItem = expenseItem({ amount: 1000, description: "taxi", needs_review: true });
  ambiguousItem.currency = null;
  ambiguousItem.currency_candidates = ["INR", "IDR"];
  ambiguousItem.review_reason = "currency_ambiguous";
  const draft = await repo.createDraft(user.id, "taxi 1000 rupees", [ambiguousItem]);

  const persisted = await repo.getDraftForTelegramUser(draft.id, telegramUserId);
  assert.equal(persisted.items[0].currency, null);
  assert.deepEqual(persisted.items[0].currency_candidates, ["INR", "IDR"]);
  await assert.rejects(
    () => repo.saveDraftAsExpense(draft.id, telegramUserId),
    { code: "currency_selection_required" }
  );
  const selected = await repo.updateDraftItemForTelegramUser(draft.id, 0, telegramUserId, {
    currency: "INR",
    currency_candidates: undefined,
    review_reason: undefined,
    needs_review: false
  });
  assert.equal(selected.items[0].currency, "INR");
  const saved = await repo.saveDraftAsExpense(draft.id, telegramUserId);
  assert.equal(saved.expenses[0].currency_original, "INR");
});

test("explicit review acceptance saves the historical IDR backlog atomically and idempotently", async () => {
  const telegramUserId = 990019;
  const user = await createSmokeUser(telegramUserId);
  await repo.updateUserSettings(telegramUserId, {
    monthlyBudgetAmount: 45000000,
    baseCurrency: "IDR",
    displayCurrency: "USD"
  });
  const fixtures = [
    { description: "breakfast, fairyteller print", amount: 170000, spent_at: "2026-08-03T05:00:00.000Z", category_slug: "food_cafe", needs_review: true },
    { description: "shop", amount: 220000, spent_at: "2026-07-20T05:00:00.000Z", category_slug: "groceries", needs_review: true },
    { description: "shop", amount: 60000, spent_at: "2026-06-29T05:00:00.000Z", category_slug: "other", needs_review: true }
  ];
  const drafts = [];
  for (const item of fixtures) {
    drafts.push(await repo.createDraft(user.id, item.description, [expenseItem({
      ...item,
      currency: "IDR",
      category_source: "parser"
    })]));
  }

  const preview = await previewSmartSaveRecovery({ telegramUserId, repository: repo, now: new Date("2026-08-17T00:00:00.000Z") });
  assert.deepEqual(
    { draftCount: preview.draftCount, itemCount: preview.itemCount, acceptItemCount: preview.acceptItemCount, requiresInputItemCount: preview.requiresInputItemCount },
    { draftCount: 3, itemCount: 3, acceptItemCount: 3, requiresInputItemCount: 0 }
  );
  const accepted = await acceptReviewRecovery({
    telegramUserId,
    draftIds: drafts.map((draft) => draft.id),
    repository: repo,
    now: new Date("2026-08-17T00:00:00.000Z")
  });
  assert.equal(accepted.savedCount, 3);

  const retry = await Promise.all([
    repo.confirmDraftWithExplicitAcceptance(drafts[0].id, telegramUserId),
    repo.confirmDraftWithExplicitAcceptance(drafts[0].id, telegramUserId)
  ]);
  assert.deepEqual(retry.map((result) => result.alreadySaved), [true, true]);
  const expenses = await pool.query(
    "SELECT amount_original, currency_original, category_slug, spent_at FROM expenses WHERE user_id = $1 ORDER BY spent_at DESC",
    [user.id]
  );
  assert.equal(expenses.rowCount, 3);
  assert.deepEqual(expenses.rows.map((row) => [Number(row.amount_original), row.currency_original, row.category_slug, row.spent_at.toISOString()]), [
    [170000, "IDR", "food_cafe", "2026-08-03T05:00:00.000Z"],
    [220000, "IDR", "groceries", "2026-07-20T05:00:00.000Z"],
    [60000, "IDR", "other", "2026-06-29T05:00:00.000Z"]
  ]);
  const acceptedDrafts = await pool.query("SELECT items FROM drafts WHERE user_id = $1 ORDER BY id", [user.id]);
  assert.ok(acceptedDrafts.rows.every((row) => row.items.every((item) => item.category_source === "user" && item.needs_review === false)));
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
    needs_review: overrides.needs_review ?? false,
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
