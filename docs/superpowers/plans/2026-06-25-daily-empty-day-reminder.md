# Daily Empty-Day Reminder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build timezone-aware local-date behavior and a safe MVP daily empty-day Telegram reminder.

**Architecture:** Add a shared timezone helper, route API date calculations through user timezones, then layer a focused reminder repository/service/job on top. Keep the Mini App setting small and use existing Telegram callback and `app_events` patterns.

**Tech Stack:** Node.js ESM, `node:test`, PostgreSQL migrations, Telegram Bot HTTP API, browser `Intl.DateTimeFormat`.

---

### Task 1: Shared Timezone Helper

**Files:**
- Modify: `packages/shared/src/time.js`
- Modify: `packages/shared/test/time.test.js`

- [ ] Write failing tests for `normalizeTimeZone`, `localDateKey`, timezone-aware `localPeriodBounds`, and invalid fallback.
- [ ] Run `node --test packages/shared/test/time.test.js` and confirm the new tests fail because the helper API does not exist.
- [ ] Implement the helper with `Intl.DateTimeFormat`, defaulting to `Asia/Bangkok`.
- [ ] Run `node --test packages/shared/test/time.test.js` and confirm the helper tests pass.

### Task 2: Schema And Repository Timezone Persistence

**Files:**
- Modify: `apps/api/migrations/001_initial.sql`
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/test/repository.test.js`

- [ ] Write failing repository tests for saving `timezone`, rejecting invalid timezone into fallback, and preserving existing settings.
- [ ] Run `node --test apps/api/test/repository.test.js` and confirm the new tests fail.
- [ ] Add `users.timezone`, `users.daily_entry_reminder_enabled`, `daily_reminder_deliveries`, and `no_spending_marks`.
- [ ] Update `updateUserSettings` to persist normalized timezone.
- [ ] Run `node --test apps/api/test/repository.test.js`.

### Task 3: Timezone-Aware Existing Date Flows

**Files:**
- Modify: `apps/api/src/repository.js`
- Modify: `packages/shared/src/budget.js`
- Modify: `packages/shared/test/budget.test.js`
- Modify: `apps/api/test/repository.test.js`

- [ ] Write failing tests showing `today`/`yesterday`, month/week totals, daily budget keys, and planned payment occurrence checks use the user's timezone instead of fixed UTC+7.
- [ ] Run focused shared/API tests and confirm failures.
- [ ] Replace hardcoded UTC+7 calculations with shared helper calls or timezone-aware SQL expressions.
- [ ] Run focused tests again.

### Task 4: Reminder Service And Scheduler

**Files:**
- Create: `apps/api/src/dailyReminderService.js`
- Create: `apps/api/test/dailyReminderService.test.js`
- Modify: `apps/api/src/config.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/test/repository.test.js`

- [ ] Write failing service tests for all core eligibility gates, rollout stability, 48h cap, idempotency, missing/invalid timezone events, sent/failed/blocked delivery records, and no infinite retry after blocked.
- [ ] Run `node --test apps/api/test/dailyReminderService.test.js` and confirm failures.
- [ ] Implement repository methods and the reminder service with injected `sendMessage` and `now`.
- [ ] Add config env vars for `DAILY_REMINDER_GLOBAL_ENABLED`, `DAILY_REMINDER_ROLLOUT_PERCENT`, and scheduler interval.
- [ ] Wire a 5-10 minute server scheduler that exits early when the kill switch is off.
- [ ] Run focused service/repository tests.

### Task 5: Telegram Reminder Buttons

**Files:**
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/src/telegramKeyboards.js`
- Modify: `apps/api/test/telegram.test.js`
- Modify: `apps/api/test/telegramKeyboards.test.js`

- [ ] Write failing tests for reminder keyboard labels/callback data, add-expense hint, no-spending mark, and disabling reminders.
- [ ] Run `node --test apps/api/test/telegram.test.js apps/api/test/telegramKeyboards.test.js` and confirm failures.
- [ ] Add reminder keyboard and callback handling.
- [ ] Run focused Telegram tests.

### Task 6: Mini App Timezone Setting

**Files:**
- Modify: `apps/miniapp/src/index.html`
- Modify: `apps/miniapp/src/app.js`
- Modify: `apps/miniapp/src/i18n.js`
- Modify: `apps/miniapp/src/settings.js`
- Modify: `apps/miniapp/test/settings.test.js`
- Modify: `apps/miniapp/test/i18n.test.js`
- Modify: `apps/miniapp/test/smokeAssets.test.js`

- [ ] Write failing tests for timezone option labels, auto-detect helper behavior, and settings form assets.
- [ ] Run focused Mini App tests and confirm failures.
- [ ] Add select, auto-detect button, translations, and save payload field.
- [ ] Run focused Mini App tests.

### Task 7: Documentation And Final Verification

**Files:**
- Modify: `docs/DOMAIN_RULES.md`
- Modify: `docs/PRODUCT_CONTEXT.md`
- Modify: `docs/TESTING_GUIDE.md`
- Modify: `docs/DECISIONS.md`
- Modify: `.env.example`
- Modify: `.env.production.example`

- [ ] Update docs with timezone and reminder rules.
- [ ] Run `rg -n "\+ 7 \* 60|interval '7 hours'|UTC\+7|Bangkok" apps packages docs` and verify any remaining references are either in the shared helper, migration backfill comments, or tests asserting fallback behavior.
- [ ] Run `npm.cmd test`.
- [ ] Review `git diff` against the approved guardrails.
