# Telegram Expense Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one reusable Telegram expense editor for drafts, saved expenses, and `/last`, with persisted input sessions and transaction-safe financial mutations.

**Architecture:** Keep rendering, callback parsing, and text parsing in focused pure modules. Route draft and saved-expense changes through separate adapters, while repository methods own session concurrency, ownership, closed-month locks, conditional daily-snapshot invalidation, and `/last` ordering.

**Tech Stack:** Node.js ESM, `node:test`, PostgreSQL 17, Telegram Bot API, existing Money Flow shared time/currency/category modules; no new dependencies.

---

## File Structure

- Create `apps/api/migrations/009_telegram_expense_editor.sql`: persisted edit sessions, constraints/indexes, and `expenses.updated_at`.
- Create `apps/api/src/telegramExpenseInput.js`: pure RU/EN amount, description, tags, and local date/time parsing.
- Create `apps/api/test/telegramExpenseInput.test.js`: parser and future-date regression tests.
- Create `apps/api/src/telegramExpenseEditor.js`: compact callback protocol, localized editor renderers/keyboards, target adapters, and domain-code mapping.
- Create `apps/api/test/telegramExpenseEditor.test.js`: pure editor/protocol/adapter tests.
- Modify `packages/shared/src/time.js` and `packages/shared/test/time.test.js`: public local-date-time-to-UTC conversion used by the editor.
- Modify `apps/api/src/telegramKeyboards.js` and `apps/api/test/telegramKeyboards.test.js`: approved draft radio states, editor entry, saved/delete/multi-item keyboards, and 64-byte checks.
- Modify `apps/api/src/telegramFormat.js` and `apps/api/test/telegramFormat.test.js`: approved draft explanation and saved-card presentation.
- Modify `apps/api/src/repository.js` and `apps/api/test/repository.test.js`: session lifecycle, draft adapter, latest lookup, locked update/delete, closed-month rules, analytics, and snapshot invalidation.
- Modify `apps/api/src/telegram.js` and `apps/api/test/telegram.test.js`: interception before parser/LLM, callbacks, `/last`, saved editor, deletion, and no-duplicate edits.
- Modify `apps/api/src/telegramCommands.js` and `apps/api/test/telegramCommands.test.js`: localized `/last` command.
- Modify `apps/api/integration/postgres-smoke.js`: real migration, locking, session, `/last`, and rollback coverage.
- Modify `docs/DOMAIN_RULES.md`, `docs/TESTING_GUIDE.md`, and `docs/deployment-runbook.md`: closed-month metadata whitelist, snapshot invalidation matrix, test/manual-release checklist.

## Task 1: Persisted Input Session Schema

**Files:**
- Create: `apps/api/migrations/009_telegram_expense_editor.sql`
- Modify: `apps/api/integration/postgres-smoke.js`

- [ ] **Step 1: Write the failing migration-ledger and schema assertions**

Extend the expected migration list with `009_telegram_expense_editor.sql`, then assert the table, partial unique index, checks, FK, and `expenses.updated_at`:

```js
assert.deepEqual(applied.rows.map((row) => row.filename), [
  "001_initial.sql", "002_draft_confirm_flow.sql", "003_budget_topups.sql",
  "004_report_deliveries.sql", "005_exchange_rates.sql", "006_feedback.sql",
  "007_account_deletion.sql", "008_product_analytics.sql",
  "009_telegram_expense_editor.sql"
]);

const sessions = await pool.query(`
  SELECT user_id, target_type, target_id, item_index, field, status,
         chat_id, message_id, language, expires_at, late_input_consumed_at
  FROM telegram_input_sessions WHERE false
`);
assert.equal(sessions.fields.length, 11);
```

- [ ] **Step 2: Run the integration test and verify red**

Run: `npm.cmd run test:integration:postgres`

Expected: FAIL because migration 009 and `telegram_input_sessions` do not exist.

- [ ] **Step 3: Add the migration**

Create an idempotent migration with this contract:

```sql
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS telegram_input_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('draft', 'expense')),
  target_id BIGINT NOT NULL,
  item_index INTEGER,
  field TEXT NOT NULL CHECK (field IN ('amount', 'description', 'spent_at', 'tags')),
  chat_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('ru', 'en')),
  status TEXT NOT NULL CHECK (status IN (
    'active', 'processing', 'completed', 'cancelled', 'expired_unconsumed', 'expired_consumed'
  )),
  expires_at TIMESTAMPTZ NOT NULL,
  late_input_consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (target_type = 'draft' AND item_index IS NOT NULL AND item_index >= 0)
    OR (target_type = 'expense' AND item_index IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS telegram_input_sessions_one_busy_user_idx
  ON telegram_input_sessions(user_id) WHERE status IN ('active', 'processing');
CREATE INDEX IF NOT EXISTS telegram_input_sessions_cleanup_idx
  ON telegram_input_sessions(status, expires_at);
```

- [ ] **Step 4: Run the integration test and verify green**

Run: `npm.cmd run test:integration:postgres`

Expected: PASS including a second idempotent migration run.

- [ ] **Step 5: Commit**

```powershell
git add apps/api/migrations/009_telegram_expense_editor.sql apps/api/integration/postgres-smoke.js
git commit -m "Add Telegram editor session schema"
```

## Task 2: Timezone-Safe Editor Input Parsing

**Files:**
- Modify: `packages/shared/src/time.js`
- Modify: `packages/shared/test/time.test.js`
- Create: `apps/api/src/telegramExpenseInput.js`
- Create: `apps/api/test/telegramExpenseInput.test.js`

- [ ] **Step 1: Write failing shared-time tests**

Add coverage for converting explicit local components through DST and non-DST zones:

```js
assert.equal(
  localDateTimeToUtc({ year: 2026, month: 7, day: 15, hour: 19, minute: 30 }, "Asia/Bangkok").toISOString(),
  "2026-07-15T12:30:00.000Z"
);
assert.equal(
  localDateTimeToUtc({ year: 2026, month: 3, day: 8, hour: 1, minute: 30 }, "America/New_York").toISOString(),
  "2026-03-08T06:30:00.000Z"
);
```

- [ ] **Step 2: Run the shared-time test and verify red**

Run: `npm.cmd test -- packages/shared/test/time.test.js`

Expected: FAIL because `localDateTimeToUtc` is not exported.

- [ ] **Step 3: Export the existing zoned conversion through a validated helper**

```js
export function localDateTimeToUtc(parts, timeZone = DEFAULT_TIMEZONE) {
  const values = [parts.year, parts.month, parts.day, parts.hour, parts.minute ?? 0];
  if (!values.every(Number.isInteger)) throw new Error("invalid_local_date_time");
  const result = zonedTimeToUtc(parts.year, parts.month, parts.day, parts.hour, timeZoneValue(timeZone, DEFAULT_TIMEZONE));
  result.setUTCMinutes(result.getUTCMinutes() + Number(parts.minute ?? 0));
  return result;
}
```

Validate the round-tripped local parts so invalid calendar dates and nonexistent DST times return `invalid_local_date_time` rather than being silently normalized.

- [ ] **Step 4: Write failing editor-input tests**

Cover all approved parsing and normalization:

```js
assert.deepEqual(parseAmountInput("120", { currentCurrency: "THB" }), { amount: 120, currency: "THB" });
assert.deepEqual(parseAmountInput("15 USD", { currentCurrency: "THB" }), { amount: 15, currency: "USD" });
assert.throws(() => parseAmountInput("NaN"), hasCode("expense_invalid_amount"));
assert.deepEqual(parseTagsInput(" work, travel, work "), ["work", "travel"]);
assert.deepEqual(parseTagsInput("-"), []);

const now = new Date("2026-07-15T12:00:00.000Z"); // 19:00 Bangkok
assert.equal(parseSpentAtInput("12 июля 19:30", { now, timeZone: "Asia/Bangkok", language: "ru" }).toISOString(), "2026-07-12T12:30:00.000Z");
assert.equal(parseSpentAtInput("20 июля 19:30", { now, timeZone: "Asia/Bangkok", language: "ru" }).toISOString(), "2025-07-20T12:30:00.000Z");
assert.throws(() => parseSpentAtInput("15 июля 20:00", { now, timeZone: "Asia/Bangkok", language: "ru" }), hasCode("expense_future_date"));
```

Also cover English month names, explicit years, leap days, invalid dates, positive finite amounts, supported currencies, description trimming/limits, tag length/count limits, today/yesterday shortcuts, and server-timezone independence.

- [ ] **Step 5: Run editor-input tests and verify red**

Run: `npm.cmd test -- packages/shared/test/time.test.js apps/api/test/telegramExpenseInput.test.js`

Expected: FAIL because the input module does not exist.

- [ ] **Step 6: Implement the pure parser module**

Export these stable functions and coded errors:

```js
export function parseAmountInput(text, { currentCurrency = "THB" } = {}) { /* strict numeric token + optional supported currency */ }
export function parseDescriptionInput(text) { /* trim, reject empty/over-limit */ }
export function parseTagsInput(text) { /* comma split, trim, dedupe, limits, '-' clears */ }
export function parseSpentAtInput(text, { now, timeZone, language }) { /* approved nearest-prior rule */ }
export function parseEditorText(field, text, context) { /* dispatch to the four functions */ }
```

Return values only; throw errors with stable codes such as `expense_invalid_amount`, `expense_invalid_currency`, `expense_invalid_description`, `expense_invalid_tags`, `expense_invalid_date`, and `expense_future_date`.

- [ ] **Step 7: Run focused tests and commit**

Run: `npm.cmd test -- packages/shared/test/time.test.js apps/api/test/telegramExpenseInput.test.js`

Expected: PASS.

```powershell
git add packages/shared/src/time.js packages/shared/test/time.test.js apps/api/src/telegramExpenseInput.js apps/api/test/telegramExpenseInput.test.js
git commit -m "Add timezone-safe Telegram editor input parsing"
```

## Task 3: Pure Editor Protocol, Renderers, and Keyboards

**Files:**
- Create: `apps/api/src/telegramExpenseEditor.js`
- Create: `apps/api/test/telegramExpenseEditor.test.js`
- Modify: `apps/api/src/telegramKeyboards.js`
- Modify: `apps/api/test/telegramKeyboards.test.js`
- Modify: `apps/api/src/telegramFormat.js`
- Modify: `apps/api/test/telegramFormat.test.js`

- [ ] **Step 1: Write failing callback and keyboard tests**

Define a compact protocol such as:

```text
ee:d:42:0:o          open draft item
ee:x:91:o            open saved expense
ee:d:42:0:f:a        request amount input
ee:x:91:b:l          set budget impact large_oneoff
ee:x:91:del           open delete confirmation
ee:x:91:delok         confirm delete
ee:d:42:p:1           multi-item selector page 1
```

Assert `parseExpenseEditorCallback` round-trips valid values, rejects malformed values, and every generated `callback_data` is at most 64 UTF-8 bytes.

Assert exact RU/EN radio states:

```js
assert.deepEqual(treatmentLabels("regular", "ru"), ["◉ Учесть сегодня", "○ Распределить до конца месяца"]);
assert.deepEqual(treatmentLabels("large_oneoff", "ru"), ["○ Учесть сегодня", "◉ Распределить до конца месяца"]);
assert.deepEqual(treatmentLabels("regular", "en"), ["◉ Count today", "○ Spread across remaining days"]);
```

- [ ] **Step 2: Write failing renderer tests**

Cover the approved draft explanation, bold HTML, editor menu, input prompts, categories, date menu, treatment explanation, deletion confirmation, generic unavailable alert, closed-month errors, expiry, and RU/EN strings. Assert all interpolated user text is HTML-escaped.

- [ ] **Step 3: Run pure tests and verify red**

Run: `npm.cmd test -- apps/api/test/telegramExpenseEditor.test.js apps/api/test/telegramKeyboards.test.js apps/api/test/telegramFormat.test.js`

Expected: FAIL because the editor module and new builders are absent.

- [ ] **Step 4: Implement the pure editor module**

Export a small public surface:

```js
export function parseExpenseEditorCallback(data) { /* compact protocol parser */ }
export function editorTargetKey(target) { /* d:id:index or x:id */ }
export function formatExpenseEditor(target, { language, timeZone }) { /* escaped HTML */ }
export function expenseEditorKeyboard(target, { language, categoryPage = 0 }) { /* field menu */ }
export function expenseInputPrompt(field, context) { /* RU/EN prompt + cancel */ }
export function expenseCategoryKeyboard(target, categories, options) { /* selected marker + pagination */ }
export function expenseDateKeyboard(target, language) { /* today/yesterday/custom/back */ }
export function expenseTreatmentKeyboard(target, language) { /* ◉ / ○ */ }
export function expenseDeleteKeyboard(target, language) { /* confirm/back */ }
export function editorMessageForCode(code, language) { /* UI mapping, no repository prose */ }
```

Use the existing category model for slugs and labels. Add an explicit localized label map for English because `CATEGORIES.name` is Russian. Keep pagination deterministic and compact.

- [ ] **Step 5: Update the draft and saved presentation**

In `draftKeyboard`, keep `✅ Сохранить`, use `◉ / ○`, make `✏️ Исправить` a callback, retain `🗑 Отменить`, Review later, and Mini App. For multi-item drafts omit treatment rows and route Edit to the selector.

In `formatDraft`, render the approved “Как учесть расход?” / “How should this expense affect the budget?” copy for one item. Preserve current multi-item formatting without pretending one shared treatment exists.

Add a saved keyboard builder that keeps the existing `formatSavedSummary` body and adds Edit/Delete plus a final Mini App row.

- [ ] **Step 6: Run focused tests and commit**

Run: `npm.cmd test -- apps/api/test/telegramExpenseEditor.test.js apps/api/test/telegramKeyboards.test.js apps/api/test/telegramFormat.test.js`

Expected: PASS with no mojibake and all callbacks below 64 bytes.

```powershell
git add apps/api/src/telegramExpenseEditor.js apps/api/test/telegramExpenseEditor.test.js apps/api/src/telegramKeyboards.js apps/api/test/telegramKeyboards.test.js apps/api/src/telegramFormat.js apps/api/test/telegramFormat.test.js
git commit -m "Add Telegram expense editor presentation"
```

## Task 4: Repository-Backed Session Lifecycle

**Files:**
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/test/repository.test.js`
- Modify: `apps/api/integration/postgres-smoke.js`

- [ ] **Step 1: Write failing repository contract tests**

Cover:

```js
const created = await repo.startTelegramInputSession(telegramUserId, {
  targetType: "draft", targetId: draft.id, itemIndex: 0, field: "amount",
  chatId: 100, messageId: 200, language: "ru"
}, now);
assert.equal(created.status, "active");

const result = await repo.consumeTelegramInputSession(telegramUserId, now, async ({ session, client }) => {
  assert.equal(session.status, "processing");
  await updateTargetWithSameClient(client);
});
assert.equal(result.outcome, "completed");
```

Add tests for atomic replacement, cancellation, validation retry, expired-unconsumed interception, one-time late consumption, completed rows never routing, ownership, and 24-hour cleanup eligibility.

- [ ] **Step 2: Run repository tests and verify red**

Run: `npm.cmd test -- apps/api/test/repository.test.js`

Expected: FAIL because the session methods are absent.

- [ ] **Step 3: Implement repository session methods**

Add:

```js
startTelegramInputSession(telegramUserId, input, now)
consumeTelegramInputSession(telegramUserId, now, applyWithClient)
cancelTelegramInputSession(telegramUserId, now)
consumeExpiredTelegramInputSession(sessionId, telegramUserId, now)
deleteOldTelegramInputSessions(now, retentionHours = 24)
```

`start` uses one transaction to lock the user, mark the previous active row `cancelled`, and insert the new active row; it must not replace a `processing` row and instead returns `input_in_progress`. `consume` holds one transaction and one DB client across row locking, the temporary `processing` transition, parser/adapter mutation, conditional snapshot invalidation, and completion. `processing` is never committed independently. Any validation or system error rolls back to the still-active session and unchanged target. A second consumer returns a non-mutating `already_consumed`/`session_not_claimable` outcome and is never passed to parser/LLM. Expired active rows become `expired_unconsumed`; that state still intercepts exactly one late input. Do not expose completed rows to routing.

- [ ] **Step 4: Add real Postgres concurrency tests**

Use two clients and `Promise.all` to prove:

- two simultaneous starts leave exactly one busy row;
- two consumers cannot apply the same session twice, and the second returns a non-mutating outcome;
- validation and system errors leave the session active and roll back the target mutation;
- an expired row intercepts one text input only;
- a completed session never intercepts the next expense.

- [ ] **Step 5: Run focused and integration tests, then commit**

Run: `npm.cmd test -- apps/api/test/repository.test.js`

Run: `npm.cmd run test:integration:postgres`

Expected: PASS.

```powershell
git add apps/api/src/repository.js apps/api/test/repository.test.js apps/api/integration/postgres-smoke.js
git commit -m "Add persisted Telegram input sessions"
```

## Task 5: Draft Target Adapter

**Files:**
- Modify: `apps/api/src/telegramExpenseEditor.js`
- Modify: `apps/api/test/telegramExpenseEditor.test.js`
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/test/repository.test.js`

- [ ] **Step 1: Write failing adapter tests**

Cover every draft field, stale version, ownership, invalid item index, confirmed/cancelled drafts, source-text preservation, and exact item selection:

```js
const result = await applyDraftEditorChange({
  repository, telegramUserId: 100,
  target: { type: "draft", id: 42, itemIndex: 1 },
  field: "amount", value: { amount: 15, currency: "USD" }
});
assert.equal(result.target.items[1].amount, 15);
assert.equal(result.target.items[0].amount, 10);
```

- [ ] **Step 2: Run tests and verify red**

Run: `npm.cmd test -- apps/api/test/telegramExpenseEditor.test.js apps/api/test/repository.test.js`

Expected: FAIL because the draft adapter method is absent.

- [ ] **Step 3: Add an atomic repository draft-item method**

Add `updateDraftItemForTelegramUser(draftId, itemIndex, telegramUserId, patch, { expectedVersion })`. Lock/read the owned pending/inbox draft, normalize and update exactly one item, increment `version`, and return stable `expense_not_found` or `expense_edit_conflict` codes.

- [ ] **Step 4: Implement `applyDraftEditorChange`**

Map editor fields to the existing draft item shape. Do not perform expense closed-month checks for an unsaved draft, but do validate future dates and values before repository mutation.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm.cmd test -- apps/api/test/telegramExpenseEditor.test.js apps/api/test/repository.test.js`

Expected: PASS.

```powershell
git add apps/api/src/telegramExpenseEditor.js apps/api/test/telegramExpenseEditor.test.js apps/api/src/repository.js apps/api/test/repository.test.js
git commit -m "Add draft expense editor adapter"
```

## Task 6: Transactional Saved-Expense Mutations

**Files:**
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/test/repository.test.js`
- Modify: `apps/api/integration/postgres-smoke.js`

- [ ] **Step 1: Write failing domain and snapshot tests**

Cover owned lookup/update/delete/latest, hard-delete idempotency, source/target closed months, metadata whitelist, future dates, preservation of `created_at` and the linked draft's `source_text`, `updated_at`, and the opening-baseline matrix:

```js
assert.equal(shouldInvalidateExpenseSnapshot(oldTodayRegular, newTodayRegular, context), false);
assert.equal(shouldInvalidateExpenseSnapshot(oldYesterdayRegular, newYesterdayRegular, context), true);
assert.equal(shouldInvalidateExpenseSnapshot(oldLargeOneOff, changedLargeOneOff, context), true);
assert.equal(shouldInvalidateExpenseSnapshot(metadataOnlyOld, metadataOnlyNew, context), false);
```

Add `/last` tests for `created_at DESC, id DESC`, a newly created backdated expense, deleted latest fallback, planned exclusion, and no `updated_at` reordering.

- [ ] **Step 2: Run repository tests and verify red**

Run: `npm.cmd test -- apps/api/test/repository.test.js`

Expected: FAIL on the new mutation outcomes and latest lookup.

- [ ] **Step 3: Add deterministic transaction locks**

Implement one shared per-user/month advisory-lock helper used by both expense mutation and `openReserveMonth` before closing instances:

```js
async function lockFinancialMonths(client, userId, monthKeys) {
  const keys = [...new Set(monthKeys)].sort();
  for (const monthKey of keys) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`money-flow:${userId}:${monthKey}`]
    );
  }
}
```

Call the same helper before closing each past reserve month so concurrent `June → July` and `July → June` operations cannot deadlock or race month closing.

- [ ] **Step 4: Replace update/delete with coded transactional methods**

Implement:

```js
getExpenseForTelegramUser(expenseId, telegramUserId)
getLatestEditableExpenseForTelegramUser(telegramUserId)
updateExpenseForTelegramUser(expenseId, telegramUserId, patch, now)
deleteExpenseForTelegramUser(expenseId, telegramUserId, now)
```

The update flow resolves rates before taking DB locks where possible, then starts a transaction, locks user and expense, derives source/target month keys from `users.timezone`, locks months in sorted order, re-checks both reserve states, permits only `description/category_slug/tags` for a closed source month, never writes `created_at` or the linked draft's `source_text`, updates `updated_at`, conditionally deletes today's snapshot, and commits. The delete flow uses the same locks and blocks closed months. Missing/deleted/non-owned targets all return `expense_not_found`.

- [ ] **Step 5: Implement explicit snapshot invalidation helper**

Export for tests or keep locally with a narrow input contract:

```js
function shouldInvalidateExpenseSnapshot(before, after, { now, timeZone }) {
  // true only when current-day opening baseline changes
}
```

Use old and new local day/month plus `budget_impact`; do not invalidate for metadata-only edits or today's regular amount changes.

- [ ] **Step 6: Add real Postgres race and rollback tests**

Prove:

- source and target months are checked inside the mutation transaction;
- a concurrent reserve close and expense move serialize safely;
- opposite-direction cross-month moves do not deadlock;
- every domain error rolls back expense and snapshot changes;
- closed months allow metadata only;
- current snapshot follows the approved invalidation matrix.

- [ ] **Step 7: Run tests and commit**

Run: `npm.cmd test -- apps/api/test/repository.test.js`

Run: `npm.cmd run test:integration:postgres`

Expected: PASS.

```powershell
git add apps/api/src/repository.js apps/api/test/repository.test.js apps/api/integration/postgres-smoke.js
git commit -m "Make expense editing transaction safe"
```

## Task 7: Message Interception Before Parser/LLM

**Files:**
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/test/telegram.test.js`
- Modify: `apps/api/src/telegramExpenseEditor.js`
- Modify: `apps/api/test/telegramExpenseEditor.test.js`

- [ ] **Step 1: Write failing routing tests**

Cover active text sessions before queue/parser/LLM, two fast messages, duplicate update delivery, validation retry, recoverable domain errors, expired late input, completed-session next expense, `/cancel`, another recognized slash command, inline Cancel, voice, and photo.

Use parser spies:

```js
let parserCalls = 0;
const expenseParser = { async parse() { parserCalls += 1; throw new Error("must not run"); } };
await bot.handleUpdate(textUpdate("120", 100));
assert.equal(parserCalls, 0);
assert.equal(repository.completedSessionId, activeSession.id);
```

- [ ] **Step 2: Run Telegram tests and verify red**

Run: `npm.cmd test -- apps/api/test/telegram.test.js apps/api/test/telegramExpenseEditor.test.js`

Expected: FAIL because pending sessions are not routed.

- [ ] **Step 3: Add the interception seam immediately after user context**

In `handleMessage`, after resolving user/language/chat but before onboarding, normal commands, queue, voice transcription, photo handling, and expense parsing:

```js
const routed = await routeTelegramExpenseInput({
  message, user, repository, now: now(), language,
  applyChange, renderEditor, editMessageText, sendMessage
});
if (routed.handled) return routed.result;
```

Route recognized slash commands before claiming a pending field input. `/cancel` cancels the active edit session and returns the current editor card; every other recognized command, including `/last`, runs normally and leaves the edit session active. Ordinary text, including an unrecognized slash-prefixed value, is claimed by the active session and follows field validation.

- [ ] **Step 4: Implement active/expired/media outcomes**

- Text + active: parse, apply target adapter, complete only on success, edit original card.
- Validation/domain recoverable error: keep session active and send localized retry message.
- Text + expired-unconsumed: mark consumed, show expiry + `/last`, never parse as expense.
- Voice/photo + active: retain session and request text or Cancel.
- Recognized command other than `/cancel` + active: dispatch the command and retain the session.
- Completed/no session: continue normal flow.

- [ ] **Step 5: Run tests and commit**

Run: `npm.cmd test -- apps/api/test/telegram.test.js apps/api/test/telegramExpenseEditor.test.js`

Expected: PASS, including zero parser/LLM calls for every intercepted outcome.

```powershell
git add apps/api/src/telegram.js apps/api/test/telegram.test.js apps/api/src/telegramExpenseEditor.js apps/api/test/telegramExpenseEditor.test.js
git commit -m "Route pending Telegram editor input safely"
```

## Task 8: Editor Callbacks for Drafts and Saved Expenses

**Files:**
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/test/telegram.test.js`
- Modify: `apps/api/src/telegramExpenseEditor.js`
- Modify: `apps/api/test/telegramExpenseEditor.test.js`
- Modify: `apps/api/src/telegramKeyboards.js`
- Modify: `apps/api/test/telegramKeyboards.test.js`

- [ ] **Step 1: Write failing callback-flow tests**

Cover opening from a draft, selecting multi-item entries/pages, every editor field, category pages, today/yesterday/custom date, treatment toggle, already-selected toast, Done/Back, saved expense editor, stale/foreign generic alert, and same-message edits with no duplicate send.

- [ ] **Step 2: Run tests and verify red**

Run: `npm.cmd test -- apps/api/test/telegram.test.js apps/api/test/telegramExpenseEditor.test.js apps/api/test/telegramKeyboards.test.js`

Expected: FAIL because editor callbacks are not routed.

- [ ] **Step 3: Route `ee:` callbacks through one dispatcher**

Parse the protocol in `handleCallback`, resolve target through the appropriate adapter, answer the callback, and edit the callback message. Keep target-specific branching inside the adapters rather than throughout the dispatcher.

For text fields, start/replace the repository session with the callback card's chat/message reference. For category/today/yesterday/treatment, apply immediately and redraw. For already-selected treatment, answer only a toast to avoid `message is not modified`.

- [ ] **Step 4: Enforce authorization and generic unavailable response**

Every adapter lookup is user-scoped. Map `expense_not_found`, stale draft, deleted expense, and foreign ID to the same localized alert:

```text
RU: Расход больше недоступен. Открой последний расход через /last.
EN: This expense is no longer available. Open your latest expense with /last.
```

- [ ] **Step 5: Run tests and commit**

Run: `npm.cmd test -- apps/api/test/telegram.test.js apps/api/test/telegramExpenseEditor.test.js apps/api/test/telegramKeyboards.test.js`

Expected: PASS with edit-in-place and no duplicate result messages.

```powershell
git add apps/api/src/telegram.js apps/api/test/telegram.test.js apps/api/src/telegramExpenseEditor.js apps/api/test/telegramExpenseEditor.test.js apps/api/src/telegramKeyboards.js apps/api/test/telegramKeyboards.test.js
git commit -m "Wire Telegram expense editor callbacks"
```

## Task 9: Saved Summary, `/last`, and Two-Step Delete

**Files:**
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/test/telegram.test.js`
- Modify: `apps/api/src/telegramCommands.js`
- Modify: `apps/api/test/telegramCommands.test.js`
- Modify: `apps/api/src/telegramKeyboards.js`
- Modify: `apps/api/test/telegramKeyboards.test.js`

- [ ] **Step 1: Write failing saved-summary and `/last` tests**

Assert confirmation keeps the current `✅ Записал` Today/Month body and adds Edit/Delete/Mini App. Add RU/EN `/last`, empty state, backdated latest, planned exclusion, and multi-item last-inserted behavior.

- [ ] **Step 2: Write failing delete tests**

Cover first-click confirmation only, Back, confirm hard-delete, snapshot/totals refresh, closed-month block, repeated confirm idempotency, stale/foreign generic alert, deleted card with dangerous buttons removed, and explicit multi-item selection before deletion.

- [ ] **Step 3: Run tests and verify red**

Run: `npm.cmd test -- apps/api/test/telegram.test.js apps/api/test/telegramCommands.test.js apps/api/test/telegramKeyboards.test.js`

Expected: FAIL because `/last` and saved actions are missing.

- [ ] **Step 4: Add `/last` command and saved keyboard**

Add menu descriptions exactly:

```js
{ command: "last", description: "Show the latest expense" }
{ command: "last", description: "Показать последний расход" }
```

The handler calls `getLatestEditableExpenseForTelegramUser`, renders the same saved-expense card/editor entry, records `last_expense_opened`, and returns the approved empty state when absent.

- [ ] **Step 5: Add two-step delete**

First callback renders confirmation only. Confirm calls the transactional repository delete, refreshes dashboard/history-derived display through existing reads, renders the deleted terminal card, and records `expense_deleted_from_telegram`. Back redraws the saved card.

- [ ] **Step 6: Run tests and commit**

Run: `npm.cmd test -- apps/api/test/telegram.test.js apps/api/test/telegramCommands.test.js apps/api/test/telegramKeyboards.test.js`

Expected: PASS.

```powershell
git add apps/api/src/telegram.js apps/api/test/telegram.test.js apps/api/src/telegramCommands.js apps/api/test/telegramCommands.test.js apps/api/src/telegramKeyboards.js apps/api/test/telegramKeyboards.test.js
git commit -m "Add latest expense and Telegram deletion flows"
```

## Task 10: Safe Analytics and Full Postgres Coverage

**Files:**
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/test/telegram.test.js`
- Modify: `apps/api/integration/postgres-smoke.js`

- [ ] **Step 1: Write failing analytics tests**

Assert best-effort events contain only approved enum metadata:

```js
assertEvent("expense_editor_opened", { targetType: "draft", source: "draft_message" });
assertEvent("expense_editor_field_changed", { field: "amount" });
assertEvent("expense_budget_impact_changed", { from: "regular", to: "large_oneoff" });
assertEvent("expense_deleted_from_telegram", {});
assertEvent("last_expense_opened", {});
```

Assert no amount, currency value, description, tags, `source_text`, chat/message IDs, or Telegram ID appears in metadata, and repository analytics failure does not break editing.

- [ ] **Step 2: Add the remaining real Postgres scenarios**

Cover amount/currency/category/date/tags/treatment updates, `created_at` preservation, `updated_at` change, latest ordering, planned exclusion, hard delete, closed-month metadata whitelist, conditional snapshot behavior, and account deletion cascading session rows.

- [ ] **Step 3: Run focused and integration tests**

Run: `npm.cmd test -- apps/api/test/telegram.test.js`

Run: `npm.cmd run test:integration:postgres`

Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
git add apps/api/src/telegram.js apps/api/test/telegram.test.js apps/api/integration/postgres-smoke.js
git commit -m "Cover Telegram editor analytics and Postgres flows"
```

## Task 11: Domain Docs, Full Verification, and Draft PR

**Files:**
- Modify: `docs/DOMAIN_RULES.md`
- Modify: `docs/TESTING_GUIDE.md`
- Modify: `docs/deployment-runbook.md`
- Review: all files changed by Tasks 1-10

- [ ] **Step 1: Update stable domain rules**

Document:

- financially closed months allow only description/category/tags edits;
- closed reserve snapshots/events stay immutable;
- no moves into/out of a closed month;
- ordinary future expense dates are rejected in user timezone;
- `/last` means most recently created existing non-planned expense;
- daily snapshot invalidation follows the opening-baseline matrix.

- [ ] **Step 2: Update testing and release checklists**

Add focused tests, Postgres concurrency cases, `/dev` Telegram steps, RU/EN screenshots, and the required User Release Notes from issue #106. Document the additive migration and forward-fix rollback strategy: disable new callbacks/session routing first; keep the table/column because destructive rollback is unnecessary.

- [ ] **Step 3: Run all focused tests**

Run:

```powershell
npm.cmd test -- packages/shared/test/time.test.js apps/api/test/telegramExpenseInput.test.js apps/api/test/telegramExpenseEditor.test.js apps/api/test/telegramKeyboards.test.js apps/api/test/telegramFormat.test.js apps/api/test/repository.test.js apps/api/test/telegram.test.js apps/api/test/telegramCommands.test.js
```

Expected: PASS.

- [ ] **Step 4: Run the real Postgres suite**

Run: `npm.cmd run test:integration:postgres`

Expected: PASS against a disposable localhost database whose name contains `test`.

- [ ] **Step 5: Run the full unit suite and diff checks**

Run: `npm.cmd test`

Expected: PASS.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 6: Perform the mandatory development Telegram check**

Using `/dev` and the development bot/client only, verify the issue checklist in RU and EN: draft, `◉ / ○` switching, all fields, invalid/future date retry, saved edit, `/last`, delete Back/confirm, expired input, voice/photo, closed-month restrictions, multi-item selection, and no duplicate messages. Capture screenshots showing both selected states and the preserved `✅ Записал` summary.

- [ ] **Step 7: Review scope and commit docs**

Run: `git diff origin/master...HEAD --stat`

Expected: only Telegram editor, repository/migration, tests, and required docs.

```powershell
git add docs/DOMAIN_RULES.md docs/TESTING_GUIDE.md docs/deployment-runbook.md
git commit -m "Document Telegram expense editor behavior"
```

- [ ] **Step 8: Push and open a draft PR**

Push the task branch and open a draft PR into `master`. Include summary, changed areas, docs checked, exact test commands/results, additive DB impact, forward-fix plan, screenshots, manual RU/EN checklist, assumptions, issue link, and the approved `## User Release Notes` block. Stop before merge or deploy.
