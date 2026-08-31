# Money Flow Testing Guide

Use this guide when changing business logic or UI around the main Money Flow surfaces.

## Always Consider

- Monthly budget calculation.
- Budget top-up calculation on top of regular budgets, overrides, and partial-month budgets.
- Mid-month onboarding budget behavior.
- Planned payment occurrence logic.
- Planned create/update/disable mutations: live monthly obligations and forecast change immediately, an existing current-local-day opening snapshot and its `dayPlanLimit` remain fixed, a missing same-day snapshot uses the current active plan state, and the next local day creates a fresh snapshot.
- Planned disable lifecycle: transaction rollback safety, first-transition `disabled_at`, idempotent retries, ownership isolation, ordinary PATCH rejection of `active`, preserved payment/expense rows, and no duplicate lifecycle event.
- Planned archive/recreate lifecycle: read-only archive ownership, valid-payment aggregation, exact 404-before-payload error precedence, locked source recheck, reserve validation on the same transaction client, independent new IDs, repeated intentional recreate, no copied payment/expense rows, and unchanged archived source fields.
- Planned `starts_on`: migration `012` is additive and nullable with no backfill; `NULL` preserves legacy occurrences, while a value applies the same user-calendar filter in dashboard, reserve, reports, Pay, and Mini App helpers. Cover PostgreSQL `DATE` objects in a non-UTC process timezone.
- Mini App recreate synchronization: one POST per form session, mutation failure keeps the form retryable, HTTP `201` closes before refresh, and independent dashboard/archive refresh failures show a warning without reopening or retrying creation.
- Planned month summary: valid paid occurrences from active and disabled plans use actual same-user linked expense amounts; remaining includes only active unpaid occurrences; base/display paid, remaining, and total values reconcile after rounding.
- Planned payment undo: exact occurrence selection across weekly/twice-monthly/monthly/one-off plans; same-user link integrity; idempotent retry; closed reserve month rollback; archive-capable repository route; unchanged current-day opening snapshot; post-commit privacy-minimal analytics; exact-date Mini App controls with one-request lifecycle and RU/EN error text.
- User timezone behavior for today/yesterday, weeks, months, daily budget snapshots, planned payment dates, and reminders.
- Daily empty-day reminder guardrails: kill switch, rollout, 48-hour cap, idempotency, no-spending marks, and Telegram blocked/forbidden errors.
- Planned-payment reminder guardrails: production-default kill switch, configured local send hour, exact-occurrence idempotency, snooze-only notification changes, stale callbacks, RU/EN copy and styles, shared saved summary, Mini App best-effort card sync, and same-evening empty-day suppression.
- Quick Capture: durable `user_id + clientRequestId` replay for safe auto-save and review drafts, concurrent claims, parser-outside-transaction behavior, retained parser category provenance, and the final `saveDraftAsExpense()` idempotency boundary.
- iPhone Shortcut: bearer-token auth, durable `token_id + clientRequestId` replay, shared Smart Save classification, immediate safe save, shared-Inbox review results, and one financial fact after lost-response or concurrent retries. First delivery mirrors the existing Telegram saved receipt or draft preview/confirmation controls; a replay emits no second Telegram message. Regress clear RU/EN grocery input (`Кефир 11 рублей` / `Kefir 11 rubles`) from the former `needs_review` parser result to a saved result without weakening real ambiguity safeguards.
- Smart Save: shared eligibility across Mini App Quick Capture, Telegram text/voice, preview, and recovery mutation; durable Telegram `user_id + chat_id + message_id` replay; complete `pending`/`inbox` visibility; per-draft reclassification; preserved historical `spent_at`; closed-month skips; and retry/concurrency idempotency through `saveDraftAsExpense()`.
- Shortcut setup: dedicated Settings sheet, prepare first and copy/activate/open only from a second fresh tap, activation retry, failed copy/network preserving an existing active key, missing-URL retry/support state, and no raw key in initial HTML, persistence, logs, or analytics. A rejected/missing clipboard must not open iCloud; it offers the explicit Show key fallback with a temporary selectable read-only field, then Open Shortcut.
- Disabled planned payments.
- Weekly recurrence deduplication.
- Reserve logic.
- Dashboard cards and budget state display.
- Currency rounding and display currencies.
- Budget top-up confirm/undo idempotency, current-day snapshot invalidation, and reserve budget synchronization.
- Budget top-up month boundaries: current-month confirmation is allowed, previous-month button confirmation is rejected, and no leftover/top-up rolls over automatically.
- Weekly and monthly report period boundaries, delivery idempotency, dry-run backfill, and blocked-bot behavior.
- Report accounting: paid planned actual linked amounts, budget top-ups as capacity, large one-offs inside total but outside daily projection, and hidden outside-budget block unless an existing model supplies it.
- Weekly report presentation: localized category names (no internal keys leaked in RU or EN), top-3 categories with percentages, up to five largest expenses, week-over-week comparison only when the previous week had spending, first-week handling, threshold-gated "what changed", needs-attention from unpaid planned payments (with stronger overdue wording), and a data-grounded takeaway that hides when unsupported.

## Practical Test Pointers

- Budget and pace logic lives primarily in `packages/shared/src/budget.js` and `packages/shared/test/budget.test.js`.
- Currency support lives in `packages/shared/src/currencies.js`, Mini App currency helpers, and their tests. Cover mandatory ISO codes, exact aliases, unresolved ambiguous families, strict settings validation, and the no-fabricated-rate path for expanded currencies.
- Planned payment behavior is spread across shared parsing, API repository logic, Telegram callbacks, Mini App planned UI, and related tests. Lifecycle changes need canonical occurrence tests, repository and budget/reserve coverage, server archive/recreate/DELETE/PATCH contract coverage, pure Mini App interaction tests in RU and EN, and narrow-width visual verification of archive and recreate states.
- Timezone helpers live in `packages/shared/src/time.js` and are covered by `packages/shared/test/time.test.js`.
- Daily reminder behavior is covered by `apps/api/test/dailyReminderService.test.js`, repository tests, and Telegram callback tests.
- Planned-payment reminder behavior is covered by `apps/api/test/plannedPaymentReminderService.test.js`, `apps/api/test/plannedPaymentReminderCallback.test.js`, `apps/api/test/plannedPaymentReminderSync.test.js`, keyboard/config/repository tests, and the PostgreSQL smoke.
- Telegram editor text-input changes must cover prompt persistence, retry after validation errors, session cleanup on Cancel/Save/terminal actions, and a fresh editor card after successful input.
- Report behavior is covered by `apps/api/test/reportPeriods.test.js`, `apps/api/test/reportService.test.js`, `apps/api/test/reportFormat.test.js`, `apps/api/test/reportAnalytics.test.js`, `apps/api/test/reportKeyboards.test.js`, `apps/api/test/reportScheduler.test.js`, and repository delivery tests. Weekly comparison/changes/takeaway/needs-attention logic is unit-tested in `apps/api/test/reportAnalytics.test.js`, and the bilingual category label resolver in `packages/shared/test/categories.test.js`.
- Dashboard presentation is covered by Mini App dashboard, localization, pager state, and smoke asset tests. Cover all hero states (including a zero daily target), the mobile Budget and plan 2-by-2 grid, weekly remainder independent of the monthly free balance, editable recent-expense rows, and recognizable calendar/gear navigation icons. Verify horizontal drag tracking and commit/snapback across Dashboard, History, Plan, and Settings while vertical scrolling, inputs, sheets, editors, onboarding, deleted state, and edge resistance remain guarded. Visually verify RU and EN at 375, 390, and 430 CSS pixels with no horizontal overflow or clipped long labels, and confirm the themed root remains visible during iOS overscroll.
- Settings behavior, including current-month budget display and timezone controls, is covered by Mini App settings tests. Check the Siri & Shortcut sheet in RU/EN and light/dark at 375, 390, and 430 CSS pixels: it must keep vertical scrolling, preserve safe areas, and not clip its primary, reconfigure, manual-key, or Open Shortcut actions. On an iPhone, verify preparation alone does not open iCloud, Copy key and open Shortcut copies before network activation, and the manual fallback appears only after clipboard failure.
- Shortcut real-device acceptance includes the locked iPhone side-button path: Siri invokes `Занеси расход`, prompts **«Назовите расход»**, sends a clear expense without opening/unlocking the Mini App, says the terminal saved result, and stops listening. Keep every terminal branch free of a follow-up input, alert, or app-opening action; an action that opens an app requires unlock on a locked device.
- Voice budget top-up coverage should use digit transcriptions for MVP behavior; amount-word parsing needs a dedicated parser or LLM fallback test before being claimed.
- Regular expense parser changes must run the synthetic RU/EN corpus in `packages/shared/testFixtures/expense-parser-regression-corpus.js`. The corpus contains invented phrases only and must cover `local_safe`, `local_reviewable`, diagnostic `local_rejected`, unambiguous multi-expense input, and protected high-risk intents.
- Parser routing tests must prove that only `local_safe` is local primary inside the existing enabled rollout, while `local_reviewable` uses LLM and falls back to its category-selection draft on LLM failure. High-risk intents always use LLM fallback or a controlled reject. Repository and Telegram tests must keep parser-provided `other` unconfirmable until explicit category selection.
- Historical parser audit coverage lives in `apps/api/test/parserAudit.test.js` and `apps/api/test/parserAuditScript.test.js`. It must prove read-only transaction/timeout/rollback behavior, dedicated safe database targeting, threshold floors, confirmed-category truth, RU/EN separation, and suppression of raw or identifying values.
- Historical shadow-adjudication coverage lives in `apps/api/test/shadowAdjudicationAudit.test.js` and `apps/api/test/shadowAdjudicationAuditScript.test.js`. It must prove that uncoupled historical critical disagreements remain `unadjudicable`, output only safe aggregate enums and field counts, use only a local copy/read replica, and enforce read-only transaction/timeout/rollback behavior.
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
- Telegram capture replay plus mixed Smart Save recovery, including ambiguous and closed-month drafts, repeat mutation, and preserved historical dates;
- explicit review acceptance for parser `needs_review`, parser `other`, historical multi-currency dates, batch retry/concurrency, and draft/item recovery counts without weakening strict Smart Save;
- dashboard budget summary over real rows;
- planned payment create/list/pay/undo/deactivate/archive/recreate/reminder state, including migrations `011`–`013`, `disabled_at`, nullable `starts_on`, durable exact-occurrence delivery and snooze, exact payment-link undo with closed-month rollback and idempotent retry, transactional and idempotent disable, archive aggregates, independent recreate with transaction-client reserve validation, preserved paid history, PostgreSQL calendar-date semantics, same-day snapshot stability, immediate live month recalculation, and next-local-day snapshot creation;
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

For UI work, also use the local acceptance sandbox described in `README.md` and check the affected dashboard/settings/planned-payment flows on narrow mobile widths. Archive/recreate changes require RU and EN screenshots of the expanded archive and recreate form at iPhone 11 and iPhone 14 Pro widths, including long synthetic text, a large synthetic amount, multiple saved payments, and a legacy null disable date. Verify no horizontal scroll, clipped text, overflowing buttons, or active controls on archived rows.

## Mini App Startup Performance

- Keep ordinary Dashboard startup independent from History. The first History request belongs to the first History tab activation; deep-linked History waits for that one request and concurrent activations reuse the same in-flight promise.
- `index.html` must acknowledge Telegram with `WebApp.ready()` and `expand()` before the main ES module graph evaluates. The module owns the remaining safe-area, theme, fullscreen, swipe, and event-listener setup and must not repeat those bootstrap calls.
- `/api/dashboard` exposes privacy-safe phase durations through `Server-Timing`. A request over the startup threshold emits one structured warning containing only the route, status, and aggregate timings; never add init data, Telegram IDs, tokens, or user/financial payloads.
- After Dashboard becomes usable, the Mini App sends one best-effort authenticated `/api/startup-timing` report. Slow client logs contain only allowlisted numeric durations for Telegram SDK, SDK resource download, app bootstrap, navigation TTFB, app/CSS resources, Dashboard request/render, and total startup; reporting must never delay or fail Dashboard.
- Preserve reserve reconciliation and financial-month locks while profiling. `Server-Timing` must distinguish `reserve_user_lock`, `reserve_past_lock`, `financial_month_lock`, `reserve_rollover`, `reserve_current_lock`, and `reserve_template_lock` so the aggregate `reserve` duration cannot hide a blocking row lock. Any later lock-strategy change requires a real PostgreSQL concurrency regression in addition to unit coverage.
- Production serves the Mini App from `apps/miniapp/dist`: `npm run build:miniapp` must collapse the source module graph into one versioned `app.js` bundle. Local development and unit tests continue to use the modules in `apps/miniapp/src`.
- Static HTML and unversioned development modules must revalidate. Only assets with an explicit deployment version query may receive immutable one-year caching, and the root JS/CSS versions must advance together.
- Start the versioned CSS and root module fetches before the blocking external Telegram SDK, but keep root module execution after `WebApp.ready()`/`expand()` so authentication and Telegram lifecycle ordering remain unchanged.
- For browser diagnostics, append `debugStartup=1` and inspect `window.__moneyFlowStartupTimings`. Record the environment with before/after numbers; local browser timings are not a substitute for a real Telegram mobile launch.

## Product Analytics Contracts

- Test new-user funnels with `users.created_at` as the cohort anchor and require entry events at or after account creation.
- Test activation against the first `expense_saved`, including event ordering after `bot_started` or `miniapp_opened`.
- Cover mature D1 `[24h, 48h)` and D7 `[6d, 8d)` denominators, meaningful return activity, and empty-cohort rendering.
- Cover Habit grouping with the current `users.timezone`, report-click delivery validation, unique-user CTR, anonymous deletion counts, and missing legacy attribution.
- `## User Release Notes` contains only user-visible changes; exclude internal SQL, index implementation, and event taxonomy details.
