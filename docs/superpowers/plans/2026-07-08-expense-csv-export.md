# Expense CSV Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe CSV export for confirmed user expenses from Telegram and Mini App Settings.

**Architecture:** Create a shared API-side export service and CSV writer used by both Telegram callbacks and a Mini App endpoint. Fetch only confirmed `expenses` scoped through internal `users.id`; deliver the generated CSV only through Telegram `sendDocument`.

**Tech Stack:** Node.js ESM, `node:test`, existing Money Flow repository/API/Telegram/Mini App modules, no new dependencies.

---

## File Structure

- Create `apps/api/src/csvWriter.js`: generic CSV writer with BOM and CSV escaping.
- Create `apps/api/test/csvWriter.test.js`: writer tests.
- Create `apps/api/src/expenseExportService.js`: period validation, throttling, row mapping, filename selection, Telegram delivery orchestration.
- Create `apps/api/test/expenseExportService.test.js`: service tests.
- Modify `apps/api/src/repository.js`: add paginated confirmed-expense export query scoped by internal user id.
- Modify `apps/api/test/repository.test.js`: repository export tests.
- Modify `apps/api/src/telegram.js`: `/export` command, export callbacks, `sendDocument` adapter.
- Modify `apps/api/test/telegram.test.js`: Telegram flow tests.
- Modify `apps/api/src/telegramCommands.js` and `apps/api/test/telegramCommands.test.js`: command menu.
- Modify `apps/api/src/server.js` and API tests: Mini App endpoint.
- Modify `apps/miniapp/src/index.html`, `apps/miniapp/src/app.js`, `apps/miniapp/src/i18n.js`, `apps/miniapp/src/styles.css`, and Mini App tests: Settings export entry.

## Task 1: CSV Writer

**Files:**
- Create: `apps/api/src/csvWriter.js`
- Create: `apps/api/test/csvWriter.test.js`

- [ ] **Step 1: Write failing CSV writer tests**

Test BOM, header order, quote/comma/newline escaping, empty values, and Russian text.

Run: `npm.cmd test -- apps/api/test/csvWriter.test.js`

Expected: FAIL because `apps/api/src/csvWriter.js` does not exist.

- [ ] **Step 2: Implement minimal CSV writer**

Export `writeCsv(rows, headers)` that returns a UTF-8 BOM-prefixed string. Quote fields only when needed and escape quotes by doubling them.

- [ ] **Step 3: Verify green**

Run: `npm.cmd test -- apps/api/test/csvWriter.test.js`

Expected: PASS.

## Task 2: Repository Export Query

**Files:**
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/test/repository.test.js`

- [ ] **Step 1: Write failing repository tests**

Cover current-month timezone bounds, all-time no period bounds, internal `users.id` scoping, oldest-to-newest order, selected columns only, and page options.

Run: `npm.cmd test -- apps/api/test/repository.test.js`

Expected: FAIL because export query method is missing.

- [ ] **Step 2: Implement repository method**

Add `listExpenseExportRowsForTelegramUser(telegramUserId, { period, cursor, limit, now })`. Resolve the user once, build bounds for `period === "month"` using `users.timezone`, query `expenses` by `user.id`, order by `spent_at ASC, id ASC`, and return rows with display amounts.

- [ ] **Step 3: Verify green**

Run: `npm.cmd test -- apps/api/test/repository.test.js`

Expected: PASS.

## Task 3: Shared Export Service

**Files:**
- Create: `apps/api/src/expenseExportService.js`
- Create: `apps/api/test/expenseExportService.test.js`

- [ ] **Step 1: Write failing service tests**

Cover required columns, `type=expense`, filename for month/all time, empty result returns no document payload, pagination combines pages, throttling is per user, and no forbidden fields appear in CSV.

Run: `npm.cmd test -- apps/api/test/expenseExportService.test.js`

Expected: FAIL because service module is missing.

- [ ] **Step 2: Implement service**

Add `createExpenseExportService({ repository, sendDocument, now, cooldownMs })`. Expose `requestExport({ telegramUserId, chatId, period, language })`, validate period as `month` or `all`, fetch pages, build CSV through `csvWriter`, and call `sendDocument`.

- [ ] **Step 3: Verify green**

Run: `npm.cmd test -- apps/api/test/expenseExportService.test.js`

Expected: PASS.

## Task 4: Telegram `/export`

**Files:**
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/test/telegram.test.js`
- Modify: `apps/api/src/telegramCommands.js`
- Modify: `apps/api/test/telegramCommands.test.js`

- [ ] **Step 1: Write failing Telegram tests**

Cover `/export` period picker, current-month callback sends document, all-time callback sends document, empty state sends message and no document, throttled callback sends message and no document, and normal expense parser text still works.

Run: `npm.cmd test -- apps/api/test/telegram.test.js apps/api/test/telegramCommands.test.js`

Expected: FAIL because `/export` is unsupported.

- [ ] **Step 2: Implement Telegram flow**

Add localized export copy, keyboard callbacks such as `export:month` and `export:all`, `sendDocument` helper, and inject/use the shared export service in `createTelegramBot`.

- [ ] **Step 3: Verify green**

Run: `npm.cmd test -- apps/api/test/telegram.test.js apps/api/test/telegramCommands.test.js`

Expected: PASS.

## Task 5: Mini App Endpoint And UI

**Files:**
- Modify: `apps/api/src/server.js`
- Modify: API security/server tests
- Modify: `apps/miniapp/src/index.html`
- Modify: `apps/miniapp/src/app.js`
- Modify: `apps/miniapp/src/i18n.js`
- Modify: `apps/miniapp/src/styles.css`
- Modify: Mini App settings/export tests

- [ ] **Step 1: Write failing API and Mini App tests**

Cover `POST /api/export` accepting only `period`, resolving the Telegram user from initData auth, ignoring body/query user identifiers, returning success/error JSON, and Settings rendering export controls.

Run: `npm.cmd test -- apps/api/test/security.test.js apps/miniapp/test/settings.test.js`

Expected: FAIL because endpoint/UI do not exist.

- [ ] **Step 2: Implement endpoint and Settings UI**

Add `POST /api/export` with existing API auth, but pass only the authenticated Telegram user and `body.period` into the export service. Add compact Settings controls and localized copy explaining that the CSV arrives in Telegram.

- [ ] **Step 3: Verify green**

Run: `npm.cmd test -- apps/api/test/security.test.js apps/miniapp/test/settings.test.js`

Expected: PASS.

## Task 6: Full Verification And PR

**Files:**
- Review all touched files.

- [ ] **Step 1: Run focused export tests**

Run: `npm.cmd test -- apps/api/test/csvWriter.test.js apps/api/test/expenseExportService.test.js apps/api/test/repository.test.js apps/api/test/telegram.test.js apps/api/test/telegramCommands.test.js apps/miniapp/test/settings.test.js`

Expected: PASS.

- [ ] **Step 2: Run full suite**

Run: `npm.cmd test`

Expected: PASS.

- [ ] **Step 3: Check diff hygiene**

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 4: Prepare draft PR**

PR body must include summary, changed areas, docs checked/updated, tests run, DB/prod impact, release notes block, manual testing steps, and open assumptions. Stop after opening the draft PR.
