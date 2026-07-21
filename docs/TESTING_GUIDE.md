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
- Telegram editor text-input changes must cover prompt persistence, retry after validation errors, session cleanup on Cancel/Save/terminal actions, and a fresh editor card after successful input.
- Report behavior is covered by `apps/api/test/reportPeriods.test.js`, `apps/api/test/reportService.test.js`, `apps/api/test/reportFormat.test.js`, `apps/api/test/reportKeyboards.test.js`, `apps/api/test/reportScheduler.test.js`, and repository delivery tests.
- Dashboard presentation is covered by Mini App dashboard and smoke asset tests.
- Settings behavior, including current-month budget display and timezone controls, is covered by Mini App settings tests.
- Voice budget top-up coverage should use digit transcriptions for MVP behavior; amount-word parsing needs a dedicated parser or LLM fallback test before being claimed.
- Regular expense parser changes must run the synthetic RU/EN corpus in `packages/shared/testFixtures/expense-parser-regression-corpus.js`. The corpus contains invented phrases only and must cover `local_safe`, `local_reviewable`, diagnostic `local_rejected`, unambiguous multi-expense input, and protected high-risk intents.
- Parser routing tests must prove that `local_safe` and `local_reviewable` are local primary only inside the existing enabled rollout, while high-risk intents always use LLM fallback or a controlled reject. Repository and Telegram tests must keep parser-provided `other` unconfirmable until explicit category selection.
- Historical parser audit coverage lives in `apps/api/test/parserAudit.test.js` and `apps/api/test/parserAuditScript.test.js`. It must prove read-only transaction/timeout/rollback behavior, dedicated safe database targeting, threshold floors, confirmed-category truth, RU/EN separation, and suppression of raw or identifying values.
- Synthetic model/prompt benchmark coverage lives in `apps/api/test/parserBenchmark.test.js` and `apps/api/test/parserBenchmarkScript.test.js`. Tests must inject parser/network dependencies; ordinary `npm.cmd test` must never call a real model API. Run the real benchmark only through the explicit `npm.cmd run parser:benchmark:api -- ...` command documented in `docs/expense-parser-audit-benchmark.md`.

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
- transactional account deletion, privacy-sensitive row cleanup, safe audit metadata, and global exchange-rate preservation;
- timezone day/month boundaries with fixed dates.
- Telegram input-session atomic completion, rollback, prompt persistence, and target-specific terminal cleanup.

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

## Product Analytics Contracts

- Test new-user funnels with `users.created_at` as the cohort anchor and require entry events at or after account creation.
- Test activation against the first `expense_saved`, including event ordering after `bot_started` or `miniapp_opened`.
- Cover mature D1 `[24h, 48h)` and D7 `[6d, 8d)` denominators, meaningful return activity, and empty-cohort rendering.
- Cover Habit grouping with the current `users.timezone`, report-click delivery validation, unique-user CTR, anonymous deletion counts, and missing legacy attribution.
- `## User Release Notes` contains only user-visible changes; exclude internal SQL, index implementation, and event taxonomy details.
