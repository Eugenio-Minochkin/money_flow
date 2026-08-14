# Smart Save And Draft Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically save confident single-item Telegram expenses and let an existing user safely save every eligible `pending`/`inbox` draft in one retry-safe action without changing historical dates.

**Architecture:** Put the pure eligibility decision in one `smartSave.js` module and call it from Mini App Quick Capture, Telegram text/voice, recovery preview, and recovery mutation. Repository queries expose the complete unresolved set and closed reserve months; the batch service re-reads every selected draft and calls the existing transactional `saveDraftAsExpense()` one draft at a time, treating concurrent confirmation as an idempotent result. The Mini App renders one compact disclosure summary and refreshes Dashboard/History state after the batch.

**Tech Stack:** Node.js ESM, PostgreSQL repository transactions, Telegram Bot API adapters, vanilla Mini App JavaScript/CSS, `node:test`.

---

### Task 1: Introduce the shared Smart Save classifier

**Files:**
- Create: `apps/api/src/smartSave.js`
- Modify: `apps/api/src/quickCapture.js`
- Create: `apps/api/test/smartSave.test.js`
- Modify: `apps/api/test/quickCapture.test.js`

- [x] **Step 1: Write classifier tests for the complete eligibility contract**

```js
assert.deepEqual(classifySmartSaveDraft({ items: [safeItem] }), { eligible: true, reason: null });
assert.equal(classifySmartSaveDraft({ items: [{ ...safeItem, needs_review: true }] }).reason, "needs_review");
assert.equal(classifySmartSaveDraft({ items: [{ ...safeItem, category_slug: "other", category_source: "parser" }] }).reason, "category_required");
assert.equal(classifySmartSaveDraft({ items: [safeItem, safeItem] }).reason, "multiple_items");
```

Also cover invalid amount, unsupported currency, invalid/future date, invalid category, and `budget_impact: "planned"`.

- [x] **Step 2: Run RED**

Run: `npm.cmd test -- apps/api/test/smartSave.test.js apps/api/test/quickCapture.test.js`

Expected: FAIL because `smartSave.js` does not exist and Quick Capture still owns a duplicate rule.

- [x] **Step 3: Implement the pure classifier and route Quick Capture through it**

```js
export function classifySmartSaveDraft(draft, { now = new Date(), closedMonthKeys = new Set(), timeZone = "Asia/Bangkok" } = {}) {
  // Return { eligible, reason } after validating one ordinary expense item,
  // category provenance, amount, currency, spent_at, and closed-month state.
}
```

Keep `saveDraftAsExpense()` as the only persistence boundary and keep the exported Quick Capture predicate as a compatibility wrapper if current tests/imports need it.

- [x] **Step 4: Run GREEN**

Run: `npm.cmd test -- apps/api/test/smartSave.test.js apps/api/test/quickCapture.test.js`

Expected: PASS.

### Task 2: Expose all unresolved drafts and implement retry-safe batch recovery

**Files:**
- Modify: `apps/api/src/repository.js`
- Create: `apps/api/src/smartSaveRecovery.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/test/repository.test.js`
- Create: `apps/api/test/smartSaveRecovery.test.js`
- Modify: `apps/api/test/security.test.js`

- [x] **Step 1: Write repository and service tests for the travel backlog**

```js
const preview = await previewSmartSaveRecovery({ telegramUserId: 100, repository, now });
assert.deepEqual(preview, {
  totalUnresolved: 12,
  safeCount: 8,
  reviewCount: 4,
  safeDraftIds: [/* eight owned IDs */],
  reviewDraftIds: [/* four owned IDs */]
});
```

Assert the repository SQL uses `status IN ('pending', 'inbox')` with no 20-row truncation. For mutation, assert each ID is re-read, still-eligible drafts call `saveDraftAsExpense()` individually, concurrent `alreadySaved` is reported without failure, ambiguous/closed drafts remain untouched, and a repeated request creates nothing new.

- [x] **Step 2: Run RED**

Run: `npm.cmd test -- apps/api/test/smartSaveRecovery.test.js apps/api/test/repository.test.js apps/api/test/security.test.js`

Expected: FAIL because unresolved/batch recovery APIs do not exist.

- [x] **Step 3: Implement repository reads, preview, mutation, and authenticated routes**

```js
GET  /api/drafts/recovery-preview
POST /api/drafts/recovery-save
```

The preview response contains counts plus safe/review IDs. The mutation accepts the previewed safe IDs, scopes them to the authenticated Telegram user, re-reads each draft, reclassifies against current closed months, calls `saveDraftAsExpense()` per eligible draft, and returns per-draft `saved`, `already_saved`, `review`, or `not_found` outcomes; a closed month is `review` with reason `closed_month`.

- [x] **Step 4: Run GREEN**

Run: `npm.cmd test -- apps/api/test/smartSaveRecovery.test.js apps/api/test/repository.test.js apps/api/test/security.test.js`

Expected: PASS.

### Task 3: Auto-save confident Telegram text and voice drafts

**Files:**
- Create: `apps/api/migrations/017_telegram_expense_capture_safety.sql`
- Modify: `apps/api/src/expenseDraftService.js`
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/test/expenseDraftService.test.js`
- Modify: `apps/api/test/repository.test.js`
- Modify: `apps/api/test/telegram.test.js`

- [x] **Step 1: Write Telegram RED tests**

Create separate text and voice fixtures whose parser returns one safe item. Assert one `saveDraftAsExpense()` call, compact `formatSavedSummary()` output, `savedExpenseKeyboard()` with Edit/Delete, and exactly one `expense_saved` event. Add ambiguous and parser-generated `other` cases that retain the draft keyboard and never save. Add same-message replay/concurrency coverage keyed by the owned Telegram chat/message identity: the parser runs once, the original draft/expense is returned, and analytics are not duplicated.

- [x] **Step 2: Run RED**

Run: `npm.cmd test -- apps/api/test/expenseDraftService.test.js apps/api/test/repository.test.js apps/api/test/telegram.test.js`

Expected: FAIL because Telegram always renders a confirmation draft.

- [x] **Step 3: Apply Smart Save after draft creation**

```js
const eligibility = classifySmartSaveDraft(draft, {
  now: now(),
  timeZone: user.timezone,
  closedMonthKeys: await repository.listClosedReserveMonthsForTelegramUser(from.id)
});
if (eligibility.eligible) {
  const saved = await repository.saveDraftAsExpense(draft.id, from.id);
  // Render the saved summary and single-expense Edit/Delete keyboard.
}
```

Create a durable capture claim before running the ordinary expense parser and complete it with the created draft, so a webhook retry for the same Telegram message returns that draft instead of parsing/inserting again. Record `expense_saved` and `expense_draft_created` only for the first completed capture; retain the existing review explanation and callback idempotency paths for non-eligible drafts.

- [x] **Step 4: Run GREEN**

Run: `npm.cmd test -- apps/api/test/expenseDraftService.test.js apps/api/test/repository.test.js apps/api/test/telegram.test.js`

Expected: PASS for text, voice, ambiguous, `other`, analytics, and saved keyboard cases.

### Task 4: Add the compact Mini App recovery disclosure

**Files:**
- Modify: `apps/miniapp/src/inbox.js`
- Modify: `apps/miniapp/src/app.js`
- Modify: `apps/miniapp/src/index.html`
- Modify: `apps/miniapp/src/i18n.js`
- Modify: `apps/miniapp/src/styles.css`
- Modify: `apps/miniapp/test/inbox.test.js`
- Modify: `apps/miniapp/test/i18n.test.js`
- Modify: `apps/miniapp/test/smokeAssets.test.js`

- [x] **Step 1: Write UI/i18n RED tests**

```js
assert.equal(recoveryTitle(18, "ru"), "Нужно разобрать 18 расходов");
assert.equal(recoverySummary({ safeCount: 14, reviewCount: 4 }, "ru"), "14 можно сохранить сразу · 4 нужно уточнить");
assert.equal(recoveryPrimaryAction(14, "ru"), "Сохранить 14 понятных");
```

Assert the primary button is absent at `safeCount = 0`, both RU/EN keys exist, the dashboard requests the all-status preview, and batch success refreshes the card without a page reload while review items remain accessible.

- [x] **Step 2: Run RED**

Run: `npm.cmd test -- apps/miniapp/test/inbox.test.js apps/miniapp/test/i18n.test.js apps/miniapp/test/smokeAssets.test.js`

Expected: FAIL because the recovery summary/actions are not rendered.

- [x] **Step 3: Implement the disclosure and batch interaction**

Render the server counts in the existing disclosure shell, send only `safeDraftIds` to the batch mutation, disable the primary action while saving, then refresh Dashboard, recovery preview, and loaded History state. Keep ambiguous rows in the existing editor/review flow.

- [x] **Step 4: Run GREEN and responsive acceptance**

Run: `npm.cmd test -- apps/miniapp/test/inbox.test.js apps/miniapp/test/i18n.test.js apps/miniapp/test/smokeAssets.test.js`

Expected: PASS; manually inspect RU/EN, light/dark at 375/390/430 CSS px with no overflow.

### Task 5: PostgreSQL integration, stable docs, and publication

**Files:**
- Modify: `apps/api/integration/postgres-smoke.js`
- Modify: `docs/DOMAIN_RULES.md`
- Modify: `docs/UI_PRINCIPLES.md`
- Modify: `docs/TESTING_GUIDE.md`
- Modify: `docs/superpowers/plans/2026-08-14-smart-save-recovery.md`

- [x] **Step 1: Add a real PostgreSQL travel-backlog smoke**

Create mixed `pending`/`inbox` drafts with historical `spent_at`, preview them, concurrently confirm one member, run batch recovery twice, and assert one expense per safe draft, unchanged historical dates, and ambiguous drafts still unresolved.

- [ ] **Step 2: Run focused and full verification**

Local unit coverage is green. The PostgreSQL smoke is implemented but could not be executed locally because Docker Desktop and a local PostgreSQL service/client were unavailable; CI remains the required execution evidence.

Final local evidence: `npm.cmd run build:miniapp` passed; `npm.cmd test` reported 1495 passed, 6 skipped, 0 failed; `git diff --check` passed.

Run:

```powershell
npm.cmd test -- apps/api/test/smartSave.test.js apps/api/test/smartSaveRecovery.test.js apps/api/test/quickCapture.test.js apps/api/test/telegram.test.js apps/api/test/repository.test.js apps/miniapp/test/inbox.test.js apps/miniapp/test/i18n.test.js apps/miniapp/test/smokeAssets.test.js
npm.cmd run test:integration:postgres
npm.cmd test
git diff --check
```

Expected: all tests pass; the integration runner targets only its disposable local test database; no whitespace errors.

- [ ] **Step 3: Update durable rules and publish a draft PR**

Document `Записано / Нужно уточнить`, all-status backlog visibility, historical date preservation, canonical per-draft save, and compact recovery UI. Commit the narrow diff, push `codex/issue-175-smart-save`, open a draft PR with `Closes #175` and the required `## User Release Notes`, then verify the exact PR head and CI. Do not merge or deploy.
