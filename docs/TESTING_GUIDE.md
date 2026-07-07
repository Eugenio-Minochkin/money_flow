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
- Budget top-up month boundaries: current-month confirmation is allowed, previous-month button confirmation is rejected, and no leftover/top-up rolls over automatically.
- Weekly and monthly report period boundaries, delivery idempotency, dry-run backfill, and blocked-bot behavior.
- Report accounting: paid planned actual linked amounts, budget top-ups as capacity, large one-offs inside total but outside daily projection, and hidden outside-budget block unless an existing model supplies it.

## Practical Test Pointers

- Budget and pace logic lives primarily in `packages/shared/src/budget.js` and `packages/shared/test/budget.test.js`.
- Currency support lives in `packages/shared/src/currencies.js`, Mini App currency helpers, and their tests.
- Planned payment behavior is spread across shared parsing, API repository logic, Telegram callbacks, Mini App planned UI, and related tests.
- Timezone helpers live in `packages/shared/src/time.js` and are covered by `packages/shared/test/time.test.js`.
- Daily reminder behavior is covered by `apps/api/test/dailyReminderService.test.js`, repository tests, and Telegram callback tests.
- Report behavior is covered by `apps/api/test/reportPeriods.test.js`, `apps/api/test/reportService.test.js`, `apps/api/test/reportFormat.test.js`, `apps/api/test/reportKeyboards.test.js`, `apps/api/test/reportScheduler.test.js`, and repository delivery tests.
- Dashboard presentation is covered by Mini App dashboard and smoke asset tests.
- Settings behavior, including current-month budget display and timezone controls, is covered by Mini App settings tests.
- Voice budget top-up coverage should use digit transcriptions for MVP behavior; amount-word parsing needs a dedicated parser or LLM fallback test before being claimed.

## Postgres Integration Smoke Tests

Postgres integration tests are smoke tests for real SQL and migrations. They intentionally cover only critical repository flows, not every repository method.

Run them separately from the unit suite:

```powershell
docker run --rm --name money-flow-postgres-smoke `
  -e POSTGRES_DB=money_flow_test `
  -e POSTGRES_USER=postgres `
  -e POSTGRES_PASSWORD=postgres `
  -p 5432:5432 `
  postgres:17
```

In another shell:

```powershell
$env:DATABASE_URL = "postgres://postgres:postgres@localhost:5432/money_flow_test"
npm.cmd run test:integration:postgres
```

The runner lives at `apps/api/integration/postgres-smoke.js` so `npm.cmd test` does not discover it by accident.

The suite refuses to run unless `DATABASE_URL` points at localhost/127.0.0.1 and the database name contains `test`. It resets the disposable database schema, applies the real migration runner, checks that a second migration pass is safe with the migration ledger, and then runs smoke coverage for:

- new Telegram user persistence and defaults;
- confirmed draft expense save/read;
- dashboard budget summary over real rows;
- planned payment create/list/pay/deactivate;
- reserve create/read through dashboard state;
- expense edit/delete and recalculated totals;
- timezone day/month boundaries with fixed dates.

GitHub Actions runs the same command in the `Postgres integration smoke` job with a disposable `postgres` service and this test-only URL:

```text
DATABASE_URL=postgres://postgres:postgres@localhost:5432/money_flow_test
```

## Before Marking Business Logic Ready

Run the relevant focused tests first, then run the full test suite:

```powershell
npm.cmd test
```

For UI work, also use the local acceptance sandbox described in `README.md` and check the affected dashboard/settings/planned-payment flows on narrow mobile widths.
