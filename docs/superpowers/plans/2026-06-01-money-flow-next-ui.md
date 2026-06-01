# Money Flow Next UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement paid planned expenses, Settings, Warm Island UI, category colors, and THB/USD dashboard display using historical converted amounts.

**Architecture:** Keep the current monorepo structure and extend the existing API/repository/Mini App files. Add small shared helpers for category colors and currency display so backend calculations and frontend rendering stay simple.

**Tech Stack:** Node.js native test runner, plain HTTP API, Postgres, vanilla HTML/CSS/JS Mini App.

---

### Task 1: Planned Expense Payment Model

**Files:**
- Modify: `apps/api/migrations/001_initial.sql`
- Modify: `apps/api/src/repository.js`
- Test: `apps/api/test/repository.test.js`

- [ ] Write failing repository tests for paying a planned expense and excluding it from current-month reserve.
- [ ] Add `planned_expense_payments` table keyed by planned expense and month.
- [ ] Add repository method `payPlannedExpenseForTelegramUser`.
- [ ] Update planned reserve calculation to ignore paid occurrences for the current month.
- [ ] Run `npm.cmd test`.

### Task 2: Historical Currency Conversion Display

**Files:**
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/migrations/001_initial.sql`
- Test: `apps/api/test/repository.test.js`
- Test: `packages/shared/test/budget.test.js`

- [ ] Write failing tests showing dashboard totals include USD display amounts.
- [ ] Store user `display_currency` and fallback exchange rate settings.
- [ ] Populate `converted_amounts.USD` for new/updated expenses and planned payments.
- [ ] Return `display` values in dashboard snapshot/top categories/latest expenses/history/planned expenses.
- [ ] Run `npm.cmd test`.

### Task 3: Settings API

**Files:**
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/src/repository.js`
- Test: `apps/api/test/repository.test.js`

- [ ] Write failing tests for updating budget/base/display currency settings.
- [ ] Add repository method `updateUserSettings`.
- [ ] Add `PATCH /api/settings`.
- [ ] Keep existing `/api/settings/budget` for compatibility.
- [ ] Run `npm.cmd test`.

### Task 4: Mini App Structure And Warm Island UI

**Files:**
- Modify: `apps/miniapp/src/index.html`
- Modify: `apps/miniapp/src/styles.css`
- Modify: `apps/miniapp/src/app.js`

- [ ] Add Settings tab and move budget form there.
- [ ] Make planned expense form collapsed behind `+ Добавить`.
- [ ] Add `Оплачено` and `Позже` actions.
- [ ] Apply Warm Island palette.
- [ ] Add category color markers for category rows and expense rows.
- [ ] Remove `/day` from USD safe-to-spend display.
- [ ] Run `node --check apps/miniapp/src/app.js`.

### Task 5: Telegram Summary Alignment

**Files:**
- Modify: `apps/api/src/telegram.js`
- Test: `apps/api/test/telegram.test.js`

- [ ] Update summary formatting to include week/planned/free remaining with cleaner labels.
- [ ] Keep Telegram HTML escaping.
- [ ] Run focused telegram tests.

### Task 6: Verification And Deployment

**Files:**
- No source-only files unless verification reveals defects.

- [ ] Run full `npm.cmd test`.
- [ ] Run node syntax checks.
- [ ] Start/verify local Mini App in browser.
- [ ] Commit and push.
- [ ] Deploy to server.
- [ ] Verify `/health`, logs, and Mini App rendering.
