# Telegram Editor Text-input UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send updated editor cards at the bottom of the Telegram chat after text input and close target-specific sessions on every terminal action.

**Architecture:** A nullable `prompt_message_id` is added to `telegram_input_sessions`. Repository methods persist the prompt reference and close only exact active targets. Telegram uses those references to remove/deactivate stale prompt/editor messages and sends one fresh editor or final card; existing financial mutations retain their transaction boundary.

**Tech Stack:** Node.js ESM, PostgreSQL migrations, Telegram Bot API adapter, `node:test`.

---

### Task 1: Persist prompt references

**Files:**
- Create: `apps/api/migrations/010_telegram_editor_prompt_message.sql`
- Modify: `apps/api/src/repository.js`
- Test: `apps/api/test/db.test.js`, `apps/api/test/repository.test.js`

- [x] **Step 1: Write failing tests**

Assert migration SQL contains `ADD COLUMN IF NOT EXISTS prompt_message_id BIGINT`. Assert `setTelegramInputSessionPrompt(telegramUserId, sessionId, expectedTarget, promptMessageId)` writes only to a matching active session and rejects foreign, processing, or terminal rows.

- [x] **Step 2: Verify RED**

Run `npm.cmd test -- apps/api/test/db.test.js apps/api/test/repository.test.js`. Expected: FAIL because migration and method are absent.

- [x] **Step 3: Implement minimally**

Add `010_telegram_editor_prompt_message.sql` with the nullable column. Add one transactionally locked repository method that writes `prompt_message_id` only for the exact active target.

- [x] **Step 4: Verify GREEN and commit**

Run `npm.cmd test -- apps/api/test/db.test.js apps/api/test/repository.test.js`. Expected: PASS.

Commit: `git commit -m "Store Telegram editor prompt references"`.

### Task 2: Close terminal sessions by target

**Files:**
- Modify: `apps/api/src/repository.js`
- Test: `apps/api/test/repository.test.js`, `apps/api/integration/postgres-smoke.js`

- [x] **Step 1: Write failing tests**

Assert `closeTelegramInputSessionForTarget` cancels the exact active draft/expense session and returns `chat_id`, `message_id`, `prompt_message_id`; it leaves another target active and returns `input_in_progress` for processing. Add a Postgres smoke case which starts a date session, closes its draft target, and confirms it is no longer routable.

- [x] **Step 2: Verify RED**

Run `npm.cmd test -- apps/api/test/repository.test.js`. Expected: FAIL because target cleanup is absent.

- [x] **Step 3: Implement minimally**

Lock user and exact target session in one transaction. Set active to `cancelled`; return processing unchanged. Do not mutate drafts, expenses, totals, snapshots, or financial validation.

- [x] **Step 4: Verify GREEN and commit**

Run `npm.cmd test -- apps/api/test/repository.test.js` and `$env:DATABASE_URL='postgres://money_flow:money_flow@localhost:5432/money_flow_test'; npm.cmd run test:integration:postgres`. Expected: PASS.

Commit: `git commit -m "Close editor sessions for terminal targets"`.

### Task 3: Refresh the text-input UI

**Files:**
- Modify: `apps/api/src/telegram.js`, `apps/api/src/telegramExpenseEditor.js`
- Test: `apps/api/test/telegram.test.js`, `apps/api/test/telegramExpenseEditor.test.js`

- [x] **Step 1: Write failing tests**

For amount, description, manual date/time, and tags, assert the flow persists the returned prompt ID. After a successful input, assert it deletes/deactivates prompt and old editor, then sends exactly one new editor card last. Assert the terminal button is `💾 Save` / `💾 Сохранить`.

- [x] **Step 2: Verify RED**

Run `npm.cmd test -- apps/api/test/telegram.test.js apps/api/test/telegramExpenseEditor.test.js`. Expected: FAIL because the old card is edited in place and button is Done.

- [x] **Step 3: Implement minimally**

Send the prompt before persisting its message ID. On completed session, best-effort delete prompt and clear old editor keyboard; regardless of deletion fallback, send one fresh editor card last. Keep validation errors on the existing session and do not create duplicate prompts. Change Done to Save without a financial update.

- [x] **Step 4: Verify GREEN and commit**

Run `npm.cmd test -- apps/api/test/telegram.test.js apps/api/test/telegramExpenseEditor.test.js`. Expected: PASS.

Commit: `git commit -m "Refresh Telegram editor after text input"`.

### Task 4: Wire every terminal Telegram action

**Files:**
- Modify: `apps/api/src/telegram.js`
- Test: `apps/api/test/telegram.test.js`

- [x] **Step 1: Write failing tests**

Cover inline prompt Cancel, Save, editor exit, draft cancel, draft confirm, saved expense delete, and target-not-found. Cancel must prove the next plain text uses the ordinary expense parser. Draft cancel with an active date session must not return `expense_invalid_date` for the next text. Cover safe Telegram deletion failure fallback and RU/EN copy.

- [x] **Step 2: Verify RED**

Run `npm.cmd test -- apps/api/test/telegram.test.js`. Expected: FAIL because terminal actions leave sessions routable.

- [x] **Step 3: Implement minimally**

Use target-specific cleanup for each terminal path. Inline Cancel sends a fresh editor; Save/exit sends saved expense or normal draft confirmation; draft cancellation/confirmation and expense deletion close matching sessions even for stale callbacks. Close unavailable targets before generic alerting.

- [x] **Step 4: Verify GREEN and commit**

Run `npm.cmd test -- apps/api/test/telegram.test.js`. Expected: PASS.

Commit: `git commit -m "Close stale Telegram editor sessions"`.

### Task 5: Documentation, verification, and draft PR

**Files:**
- Modify: `docs/DOMAIN_RULES.md`, `docs/TESTING_GUIDE.md`
- Modify: `docs/superpowers/plans/2026-07-15-telegram-editor-text-input-ux.md`

- [x] **Step 1: Document only stable UX/session rules**

State that prompts are session-scoped, fresh cards appear at the chat bottom after success/cancel, terminal actions close matching sessions, and financial semantics remain unchanged.

- [x] **Step 2: Verify**

Run focused repository/Telegram tests, local Postgres integration with `money_flow_test`, `npm.cmd test`, and `git diff --check`. Expected: all pass and diff check is empty.

- [ ] **Step 3: Publish the separate draft PR**

Commit documentation, push `codex/telegram-editor-text-input-ux`, and open a draft PR to `master` with `Closes #109`, additive migration impact, forward-fix-only rollback, exact test results, and `## User Release Notes`. Do not merge or deploy.
