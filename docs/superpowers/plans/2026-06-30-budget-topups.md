# Budget Top-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MVP budget top-ups so extra money can increase one month's available budget without changing the regular monthly budget.

**Architecture:** Add a separate `budget_topup_drafts` confirmation flow and durable `budget_topups` rows, then fold active top-ups into `currentMonthBudget()`. Telegram parses top-up intent before planned/regular expenses, while the Mini App displays a compact budget breakdown on existing dashboard surfaces.

**Tech Stack:** Node.js ESM, PostgreSQL migrations, built-in `node:test`, shared parser/time/currency helpers, Telegram inline keyboards, Mini App vanilla JS/CSS.

---

### Task 1: Database Shape

**Files:**
- Create: `apps/api/migrations/003_budget_topups.sql`
- Test: `apps/api/test/db.test.js`

- [x] **Step 1: Write the failing migration test**

Add an assertion that migration files include `budget_topup_drafts`, `budget_topups`, the partial unique index `budget_topups_user_draft_unique`, and no default on `budget_topups.exchange_rate_source`.

- [x] **Step 2: Run migration tests**

Run: `npm.cmd test -- apps/api/test/db.test.js`
Expected: FAIL because the new migration does not exist.

- [x] **Step 3: Add migration**

Create `003_budget_topups.sql` with the two tables and indexes from the task spec. Keep `exchange_rate_source TEXT NOT NULL` with no default.

- [x] **Step 4: Re-run migration tests**

Run: `npm.cmd test -- apps/api/test/db.test.js`
Expected: PASS.

### Task 2: Shared Budget Top-up Parser

**Files:**
- Create: `packages/shared/src/budgetTopupParser.js`
- Test: `packages/shared/test/budgetTopupParser.test.js`

- [x] **Step 1: Write parser tests**

Cover the RU/EN positive and negative phrases from the spec, `yesterday`, default currency, `income/refund/other` kind detection, and `failed` for top-up-looking text without a safe amount.

- [x] **Step 2: Run parser tests**

Run: `npm.cmd test -- packages/shared/test/budgetTopupParser.test.js`
Expected: FAIL because the parser module does not exist.

- [x] **Step 3: Implement parser**

Implement `parseBudgetTopupText(text, { now, defaultCurrency, timeZone })` returning `{ state: "recognized", item }`, `{ state: "not_recognized" }`, or `{ state: "failed", reason }`. Reuse `parseExpenseText()` for amount/currency/date normalization only after top-up intent is detected, and reject transfer/card/account phrases before expense parsing.

- [x] **Step 4: Re-run parser tests**

Run: `npm.cmd test -- packages/shared/test/budgetTopupParser.test.js`
Expected: PASS.

### Task 3: Repository Budget Calculation

**Files:**
- Modify: `apps/api/src/repository.js`
- Test: `apps/api/test/repository.test.js`

- [x] **Step 1: Write failing repository tests**

Add tests for base + top-up, override + top-up, partial month + top-up, top-up not appearing in expense totals/categories/heatmap, and `/api/dashboard` exposing `currentMonthBudget.baseBudget`, `topupsTotal`, `amount`, and `topups`.

- [x] **Step 2: Run focused repository tests**

Run: `npm.cmd test -- apps/api/test/repository.test.js`
Expected: FAIL because `currentMonthBudget()` ignores `budget_topups`.

- [x] **Step 3: Extend repository budget reads**

Add `listBudgetTopupsForMonth(userId, monthKey)`, load active top-ups in `currentMonthBudget()`, compute `baseBudget`, `topupsTotal`, effective `amount`, display totals, and recent top-ups with display amounts.

- [x] **Step 4: Re-run repository tests**

Run: `npm.cmd test -- apps/api/test/repository.test.js`
Expected: PASS for the added budget calculation tests.

### Task 4: Repository Draft Lifecycle, Confirm, Cancel, Undo

**Files:**
- Modify: `apps/api/src/repository.js`
- Test: `apps/api/test/repository.test.js`

- [x] **Step 1: Write failing lifecycle tests**

Cover transactional draft replacement, TTL expiry, replaced-by-newer outcome, idempotent double confirm, concurrent confirm using the unique index, cancel idempotency, undo within 10 minutes, undo expiry, current daily snapshot invalidation, backdated top-up snapshot policy, and reserve budget synchronization.

- [x] **Step 2: Run focused repository tests**

Run: `npm.cmd test -- apps/api/test/repository.test.js`
Expected: FAIL because methods are missing.

- [x] **Step 3: Implement methods**

Add `createBudgetTopupDraft`, `confirmBudgetTopupDraft`, `cancelBudgetTopupDraft`, and `undoBudgetTopup`. Use transactions, `FOR UPDATE`, `buildMoneyAmounts()`, `ON CONFLICT`/unique-index-safe duplicate handling, `updateOpenReserveBudget()`, and `invalidateDailyBudgetSnapshot()` for the current local day.

- [x] **Step 4: Re-run repository tests**

Run: `npm.cmd test -- apps/api/test/repository.test.js`
Expected: PASS for lifecycle tests.

### Task 5: Telegram Top-up Flow

**Files:**
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/src/telegramKeyboards.js`
- Modify: `apps/api/src/telegramFormat.js`
- Test: `apps/api/test/telegram.test.js`
- Test: `apps/api/test/telegramKeyboards.test.js`
- Test: `apps/api/test/telegramFormat.test.js`

- [x] **Step 1: Write failing Telegram tests**

Cover parser order before planned/expense parser, onboarding bypass, normal/large draft rendering, callback parsing for `bt:{id}:confirm|cancel|undo`, confirm success with undo keyboard, expired/replaced messages, undo success/expired, and event names.

- [x] **Step 2: Run focused Telegram tests**

Run: `npm.cmd test -- apps/api/test/telegram.test.js apps/api/test/telegramKeyboards.test.js apps/api/test/telegramFormat.test.js`
Expected: FAIL because the flow is missing.

- [x] **Step 3: Implement Telegram flow**

Wire `parseBudgetTopupText()` before `parsePlannedExpenseText()`, add `budgetTopupDraftKeyboard`, `budgetTopupUndoKeyboard`, `parseBudgetTopupCallback`, RU/EN `botText()` keys, and formatting helpers. Treat the normal "Do not count" button as the cancel callback for MVP.

- [x] **Step 4: Re-run Telegram tests**

Run: `npm.cmd test -- apps/api/test/telegram.test.js apps/api/test/telegramKeyboards.test.js apps/api/test/telegramFormat.test.js`
Expected: PASS.

### Task 6: Mini App Dashboard Breakdown

**Files:**
- Modify: `apps/miniapp/src/app.js`
- Modify: `apps/miniapp/src/i18n.js`
- Modify: `apps/miniapp/src/styles.css`
- Test: `apps/miniapp/test/dashboardCards.test.js`
- Test: `apps/miniapp/test/i18n.test.js`

- [x] **Step 1: Write failing Mini App tests**

Cover RU/EN i18n keys and rendering of base budget, top-ups, total budget, and recent top-ups only when top-ups exist.

- [x] **Step 2: Run Mini App tests**

Run: `npm.cmd test -- apps/miniapp/test/dashboardCards.test.js apps/miniapp/test/i18n.test.js`
Expected: FAIL because breakdown UI is missing.

- [x] **Step 3: Implement compact UI**

Add a compact budget breakdown near the current budget/dashboard area without creating an income card. Use existing money formatting and hide the top-up history when empty.

- [x] **Step 4: Re-run Mini App tests**

Run: `npm.cmd test -- apps/miniapp/test/dashboardCards.test.js apps/miniapp/test/i18n.test.js`
Expected: PASS.

### Task 7: Docs, Release Notes, Full Verification, PR

**Files:**
- Modify: `docs/DOMAIN_RULES.md`
- Modify: `docs/DECISIONS.md`
- Modify: `docs/PRODUCT_CONTEXT.md`
- Modify: `docs/TESTING_GUIDE.md`
- Review: `docs/deployment-runbook.md`

- [x] **Step 1: Update docs**

Document that budget top-ups increase the effective month budget only, are not expenses/income accounting, are not prorated in partial months, and invalidate only the current daily snapshot on confirm/undo.

- [x] **Step 2: Run full tests**

Run: `npm.cmd test`
Expected: PASS.

- [x] **Step 3: Review diff**

Run: `git diff --check` and `git diff`
Expected: no whitespace errors and no unrelated changes.

- [x] **Step 4: Commit and open draft PR**

Commit with `feat: add budget top-ups`, push `codex/budget-topups`, and open a draft PR into `master` with summary, changed areas, docs, tests, DB/prod impact, release notes, screenshots if applicable, and assumptions.
