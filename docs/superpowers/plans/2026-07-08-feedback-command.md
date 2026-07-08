# Feedback Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Telegram `/feedback` command that captures one user feedback message, stores it durably, and notifies admins without sending the feedback text through expense parsing.

**Architecture:** Add a `feedback` table and a repository method for persistence. In Telegram handling, `/feedback` sets a short-lived in-memory pending state for that Telegram user; the next text message is validated, saved, acknowledged, and routed to admin notification before the expense parser branch can run.

**Tech Stack:** Node.js ESM, `node:test`, PostgreSQL migrations through `apps/api/src/db.js`, existing Telegram bot and admin alert infrastructure.

---

### Task 1: Migration Contract

**Files:**
- Create: `apps/api/migrations/006_feedback.sql`
- Modify: `apps/api/test/db.test.js`

- [x] **Step 1: Write the failing migration test**

Add a test that reads `006_feedback.sql` and asserts it creates `feedback` with `id`, `user_id`, `telegram_user_id`, `message`, `created_at`, `status`, `source`, a safe status check, a safe source check, and useful indexes.

- [x] **Step 2: Run the focused test and verify RED**

Run: `npm.cmd test -- apps/api/test/db.test.js`

Expected: FAIL because `006_feedback.sql` does not exist yet.

- [x] **Step 3: Add the migration**

Create `006_feedback.sql` with `CREATE TABLE IF NOT EXISTS feedback`, `user_id` referencing `users(id) ON DELETE SET NULL`, required `telegram_user_id`, non-empty `message`, default `status = 'new'`, default `source = 'bot'`, and indexes for status/time and Telegram user/time.

- [x] **Step 4: Verify GREEN**

Run: `npm.cmd test -- apps/api/test/db.test.js`

Expected: PASS.

### Task 2: Repository Persistence

**Files:**
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/test/repository.test.js`

- [x] **Step 1: Write the failing repository test**

Add a test for `createFeedback({ userId, telegramUserId, message, source })` that asserts the SQL inserts into `feedback`, preserves `user_id`, `telegram_user_id`, `message`, defaultable `status`, and `source`.

- [x] **Step 2: Run the focused test and verify RED**

Run: `npm.cmd test -- apps/api/test/repository.test.js`

Expected: FAIL because `createFeedback` is not implemented.

- [x] **Step 3: Implement minimal repository code**

Add `createFeedback(input)` to `createRepository`, normalizing `message` with trim and inserting a row with `status = input.status ?? "new"` and `source = input.source ?? "bot"`.

- [x] **Step 4: Verify GREEN**

Run: `npm.cmd test -- apps/api/test/repository.test.js`

Expected: PASS.

### Task 3: Telegram Feedback Flow

**Files:**
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/test/telegram.test.js`

- [x] **Step 1: Write failing Telegram tests**

Cover `/feedback` prompt, next text saved as feedback, admin notification, parser bypass, normal parser resume after save, admin notification failure absorbed, too-short text retained in pending mode, and `/feedback` not creating an expense draft.

- [x] **Step 2: Run focused Telegram tests and verify RED**

Run: `npm.cmd test -- apps/api/test/telegram.test.js`

Expected: FAIL because `/feedback` is not handled.

- [x] **Step 3: Implement minimal Telegram state and routing**

Add a module-level pending feedback Map with TTL. Handle `/feedback` before queuing expense work. Check pending state at the start of `processQueuedMessage`, before sending the expense processing loader or calling any parser. Save valid text through `repository.createFeedback`, clear pending state only after save, acknowledge the user, and send best-effort admin notifications through existing `adminTelegramIds` and Telegram sender.

- [x] **Step 4: Verify GREEN**

Run: `npm.cmd test -- apps/api/test/telegram.test.js`

Expected: PASS.

### Task 4: Docs And Release Notes

**Files:**
- Modify: `CONTEXT.md`
- Modify as needed: `docs/deployment-runbook.md`

- [x] **Step 1: Keep product vocabulary precise**

Record `Feedback` as a lightweight user message for product improvement, not an expense, support ticket, or accounting record.

- [x] **Step 2: Update runbook only if needed**

If the implementation changes admin-alert/operator verification guidance, document the `/feedback` manual check and admin notification sample. Otherwise keep docs narrow and cover the sample in the PR body.

### Task 5: Verification And PR

**Files:**
- All changed files

- [x] **Step 1: Run focused checks**

Run:
`npm.cmd test -- apps/api/test/db.test.js apps/api/test/repository.test.js apps/api/test/telegram.test.js`

- [x] **Step 2: Run the full suite**

Run: `npm.cmd test`

- [x] **Step 3: Review diff**

Run: `git diff --check` and `git diff`.

- [ ] **Step 4: Commit, push, and open draft PR**

Commit on `codex/feedback-command`, push the branch, and open a draft PR into `master` with summary, changed areas, docs checked/updated, tests run, DB/prod impact, release notes impact, manual verification steps, admin notification sample, and assumptions.
