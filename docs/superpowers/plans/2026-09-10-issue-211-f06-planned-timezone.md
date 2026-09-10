# Issue 211 F06 Planned Payment Timezone Implementation Plan

**Goal:** Keep planned-payment occurrence validation and saved expense timestamps in the user's current IANA timezone at local-day boundaries.

**Architecture:** Preserve the existing model where `users.timezone` owns future calendar interpretation and `planned_expenses` stores timezone-neutral calendar fields. Repair only the two owned plan reads in `payPlannedExpenseForTelegramUser`, then prove the complete repository-to-reminder-to-payment path with a non-UTC PostgreSQL scenario.

**Tech Stack:** Node.js 24, node:test, PostgreSQL, native `Intl` IANA timezone helpers.

---

### Task 1: Reproduce and repair the payment projection

**Files:**
- Modify: `apps/api/test/repository.test.js`
- Modify: `apps/api/src/repository.js`

- [x] Add a repository regression where `paidAt = 2026-09-01T01:05:00Z` is still August 31 in `America/New_York`, and an August 31 monthly occurrence must be accepted and saved at the click instant.
- [x] Make the fake SQL projection expose `timezone` only when the production SELECT explicitly requests `users.timezone`, so the test exercises the real query contract rather than an over-complete mock row.
- [x] Run `node --test --test-name-pattern="current user timezone across UTC midnight" apps/api/test/repository.test.js`; expect `invalid_occurrence` while the query falls back to `Asia/Bangkok`.
- [x] Add `users.timezone` to both the prefetch and locked SELECTs inside `payPlannedExpenseForTelegramUser`; do not add a timezone column or scheduler abstraction.
- [x] Re-run the focused repository test and the complete `apps/api/test/repository.test.js`; expect pass.

### Task 2: Prove creation, scheduling, persistence, and compatibility

**Files:**
- Modify: `apps/api/integration/postgres-smoke.js`
- Check: `apps/api/src/plannedPaymentReminderService.js`
- Check: `apps/miniapp/src/app.js`
- Check: `apps/api/migrations/001_initial.sql`
- Check: `apps/api/migrations/013_planned_payment_reminders.sql`

- [x] Add a PostgreSQL smoke test that creates a monthly plan in `America/Chicago`, changes the user to `America/New_York`, verifies no reminder at 20:59 current-local time, verifies delivery at configured 21:00 current-local time across the UTC date boundary, pays the August 31 occurrence at 21:05 current-local time, and asserts `expenses.spent_at`, `paid_month`, and `occurrence_date` remain in August.
- [x] Confirm existing DST coverage in `plannedPaymentReminderService.test.js` and current-timezone reads in reminder/list/edit paths; add no duplicate test or migration when existing contracts already cover them.
- [ ] Run `node --test apps/api/test/repository.test.js apps/api/test/plannedPaymentReminderService.test.js` and, when a safe disposable database is available, `npm.cmd run test:integration:postgres`.
- [x] Run `npm.cmd test`, `git diff --check`, and inspect the exact diff for F06-only scope.
- [ ] Commit and push `codex/issue-211-f06-planned-timezone`, create a separate draft PR into `master`, and require Test, PostgreSQL integration smoke, and Docs Reminder to pass; do not deploy or close issue #211.
