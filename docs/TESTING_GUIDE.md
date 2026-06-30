# Money Flow Testing Guide

Use this guide when changing business logic or UI around the main Money Flow surfaces.

## Always Consider

- Monthly budget calculation.
- Budget top-up calculation on top of regular budgets, overrides, and partial-month budgets.
- Mid-month onboarding budget behavior.
- Planned payment occurrence logic.
- User timezone behavior for today/yesterday, weeks, months, daily budget snapshots, planned payment dates, and reminders.
- Daily empty-day reminder guardrails: kill switch, rollout, 48-hour cap, idempotency, no-spending marks, and Telegram blocked/forbidden errors.
- Disabled planned payments.
- Weekly recurrence deduplication.
- Reserve logic.
- Dashboard cards and budget state display.
- Currency rounding and display currencies.
- Budget top-up confirm/undo idempotency, current-day snapshot invalidation, and reserve budget synchronization.

## Practical Test Pointers

- Budget and pace logic lives primarily in `packages/shared/src/budget.js` and `packages/shared/test/budget.test.js`.
- Currency support lives in `packages/shared/src/currencies.js`, Mini App currency helpers, and their tests.
- Planned payment behavior is spread across shared parsing, API repository logic, Telegram callbacks, Mini App planned UI, and related tests.
- Timezone helpers live in `packages/shared/src/time.js` and are covered by `packages/shared/test/time.test.js`.
- Daily reminder behavior is covered by `apps/api/test/dailyReminderService.test.js`, repository tests, and Telegram callback tests.
- Dashboard presentation is covered by Mini App dashboard and smoke asset tests.
- Settings behavior, including current-month budget display and timezone controls, is covered by Mini App settings tests.

## Before Marking Business Logic Ready

Run the relevant focused tests first, then run the full test suite:

```powershell
npm.cmd test
```

For UI work, also use the local acceptance sandbox described in `README.md` and check the affected dashboard/settings/planned-payment flows on narrow mobile widths.
