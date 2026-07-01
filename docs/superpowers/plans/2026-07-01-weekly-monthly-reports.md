# Weekly And Monthly Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore weekly reports on Monday morning local time and add monthly reports for the previous closed month, with delivery records, idempotency, dry-run backfill, exact planned-payment/top-up/large-expense math, RU/EN formatting, and a draft PR for review.

**Architecture:** Add a focused reports layer under `apps/api/src/` instead of growing `telegram.js`: period/gate helpers, data collection/accounting service, text formatter, scheduler/backfill delivery service, and report keyboards. Keep `weekly_reports` as legacy and use new `report_deliveries` as the primary delivery ledger. Reuse existing timezone, budget, budget top-up, planned-payment, reserve, app event, and Telegram blocked-bot patterns.

**Tech Stack:** Node.js ESM, PostgreSQL migrations, Telegram Bot API, `node:test`, shared Money Flow time/budget/currency helpers.

---

## Confirmed Accounting Semantics

- `budget_impact = 'large_oneoff'` is included in `total_spent`.
- Explicit `large_oneoff` is excluded from daily projection base / forecast extrapolation.
- Large expenses are a display/filter view inside the total, not a third total partition.
- Visual partition is `total_spent = planned_paid_total + regular_derived`; `regular_derived = total_spent - planned_paid_total`.
- Do not invent outside-budget accounting in this PR. Hide the outside-budget block unless an existing separate model supplies a positive value.
- Preserve dashboard semantics and reuse current budget/topup/planned-payment behavior.

## File Structure

- Create `apps/api/migrations/004_report_deliveries.sql`: delivery table, constraints, and indexes.
- Create `apps/api/src/reportPeriods.js`: timezone-aware local gates, previous completed periods, period keys, UTC boundaries.
- Create `apps/api/src/reportFormat.js`: RU/EN report rendering, money/date labels, deterministic insights, empty states.
- Create `apps/api/src/reportKeyboards.js`: weekly/monthly Mini App buttons with selected period params.
- Create `apps/api/src/reportService.js`: eligibility, data collection, metrics, delivery idempotency, Telegram send handling, dry-run/backfill.
- Create `apps/api/src/reportScheduler.js`: recurring scheduler wrapper and per-user report order.
- Create `apps/api/scripts/backfill-report.js`: safe monthly backfill command with dry-run default.
- Modify `apps/api/src/repository.js`: report delivery CRUD, report candidate listing, report data queries, no-activity checks.
- Modify `apps/api/src/server.js`: replace old weekly scheduler wiring with report scheduler.
- Modify `apps/api/src/telegram.js`: remove old `sendWeeklyReports`/`shouldSendWeeklyReport` ownership or leave compatibility exports only where tests require.
- Modify `apps/api/src/telegramKeyboards.js` only if shared button helpers are better reused there.
- Modify docs: `docs/DOMAIN_RULES.md`, `docs/PRODUCT_CONTEXT.md`, `docs/TESTING_GUIDE.md`, and PR body release notes.

## Task 1: Migration And Repository Delivery Ledger

**Files:**
- Create: `apps/api/migrations/004_report_deliveries.sql`
- Modify: `apps/api/src/repository.js`
- Test: `apps/api/test/db.test.js`
- Test: `apps/api/test/repository.test.js`

- [x] **Step 1: Write failing migration test**

Add assertions to `apps/api/test/db.test.js`:

```js
test("report delivery migration creates universal delivery ledger", async () => {
  const sql = await readFile(resolve(dir, "004_report_deliveries.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS report_deliveries/i);
  assert.match(sql, /report_type TEXT NOT NULL CHECK \(report_type IN \('weekly', 'monthly'\)\)/i);
  assert.match(sql, /status TEXT NOT NULL CHECK \(status IN \('pending', 'sent', 'failed', 'skipped'\)\)/i);
  assert.match(sql, /UNIQUE\(user_id, report_type, period_key\)/i);
});
```

- [x] **Step 2: Verify the migration test fails**

Run: `node --test apps/api/test/db.test.js`

Expected: FAIL because `004_report_deliveries.sql` does not exist.

- [x] **Step 3: Add migration**

Create `apps/api/migrations/004_report_deliveries.sql`:

```sql
CREATE TABLE IF NOT EXISTS report_deliveries (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL CHECK (report_type IN ('weekly', 'monthly')),
  period_key TEXT NOT NULL,
  period_start_utc TIMESTAMPTZ NOT NULL,
  period_end_utc TIMESTAMPTZ NOT NULL,
  timezone_used TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  telegram_message_id BIGINT,
  generated_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  skip_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, report_type, period_key)
);

CREATE INDEX IF NOT EXISTS report_deliveries_user_period_idx
  ON report_deliveries(user_id, report_type, period_key);

CREATE INDEX IF NOT EXISTS report_deliveries_status_created_idx
  ON report_deliveries(status, created_at);
```

- [x] **Step 4: Run migration test green**

Run: `node --test apps/api/test/db.test.js`

Expected: PASS.

- [x] **Step 5: Write failing repository delivery tests**

Add tests in `apps/api/test/repository.test.js` that verify:

```js
await repo.createReportDelivery({
  userId: 1,
  reportType: "weekly",
  periodKey: "2026-W27",
  periodStartUtc: new Date("2026-06-29T00:00:00Z"),
  periodEndUtc: new Date("2026-07-06T00:00:00Z"),
  timezoneUsed: "UTC",
  status: "pending",
  generatedAt: new Date("2026-07-06T09:00:00Z"),
  metadata: { total_spent: 100 }
});
```

and assert the SQL uses `INSERT INTO report_deliveries`, `ON CONFLICT (user_id, report_type, period_key) DO NOTHING`, and JSON metadata.

Add another test for `markReportDeliverySent`, `markReportDeliveryFailed`, and `markReportDeliverySkipped`.

- [x] **Step 6: Verify repository tests fail**

Run: `node --test apps/api/test/repository.test.js --test-name-pattern report`

Expected: FAIL because repository methods do not exist.

- [x] **Step 7: Implement repository delivery methods**

Add methods to `createRepository`:

```js
async getReportDelivery(userId, reportType, periodKey) { ... }
async createReportDelivery(input) { ... }
async markReportDeliverySent(input) { ... }
async markReportDeliveryFailed(input) { ... }
async markReportDeliverySkipped(input) { ... }
async listReportCandidates() { ... }
```

Use the base eligible user query:

```sql
telegram_user_id IS NOT NULL
AND onboarding_step = 'completed'
AND bot_blocked = false
```

- [x] **Step 8: Run repository tests green**

Run: `node --test apps/api/test/repository.test.js --test-name-pattern report`

Expected: PASS.

## Task 2: Period Keys, Boundaries, And Gates

**Files:**
- Create: `apps/api/src/reportPeriods.js`
- Test: `apps/api/test/reportPeriods.test.js`

- [x] **Step 1: Write failing period tests**

Create `apps/api/test/reportPeriods.test.js` covering:

```js
assert.equal(weeklyPeriodForSend(new Date("2026-06-22T03:00:00Z"), "Asia/Bangkok").periodKey, "2026-W25");
assert.equal(monthlyPeriodForSend(new Date("2026-07-01T03:00:00Z"), "Asia/Bangkok").periodKey, "2026-06");
assert.equal(shouldSendWeeklyReportForUser(new Date("2026-06-22T02:30:00Z"), "Asia/Bangkok"), true);
assert.equal(shouldSendWeeklyReportForUser(new Date("2026-06-22T07:01:00Z"), "Asia/Bangkok"), false);
assert.equal(shouldSendMonthlyReportForUser(new Date("2026-07-01T02:30:00Z"), "Asia/Bangkok"), true);
assert.equal(weeklyPeriodForSend(new Date("2021-01-04T03:00:00Z"), "Asia/Bangkok").periodKey, "2020-W53");
```

- [x] **Step 2: Verify period tests fail**

Run: `node --test apps/api/test/reportPeriods.test.js`

Expected: FAIL because `reportPeriods.js` does not exist.

- [x] **Step 3: Implement period helpers**

Export:

```js
export function shouldSendWeeklyReportForUser(now, timeZone) {}
export function shouldSendMonthlyReportForUser(now, timeZone) {}
export function weeklyPeriodForSend(now, timeZone) {}
export function monthlyPeriodForSend(now, timeZone) {}
export function isoWeekKeyForLocalDate(year, month, day) {}
```

Use 09:00 inclusive to 14:00 exclusive local window, Monday for weekly, local day 1 for monthly, and UTC period boundaries.

- [x] **Step 4: Run period tests green**

Run: `node --test apps/api/test/reportPeriods.test.js`

Expected: PASS.

## Task 3: Report Accounting Data And Metrics

**Files:**
- Create: `apps/api/src/reportService.js`
- Modify: `apps/api/src/repository.js`
- Test: `apps/api/test/reportService.test.js`
- Test: `apps/api/test/repository.test.js`

- [x] **Step 1: Write failing accounting tests**

Create `apps/api/test/reportService.test.js` with a fake repository and assert:

```js
assert.equal(report.metrics.totalSpent, 1700);
assert.equal(report.metrics.plannedPaidTotal, 500);
assert.equal(report.metrics.regularTotal, 1200);
assert.equal(report.metrics.largeTotal, 900);
assert.equal(report.metrics.dailyProjectionBase, 300);
assert.equal(report.metrics.outOfBudgetTotal, 0);
```

The fixture must contain:

- regular expense `300`
- paid planned linked expense actual amount `500`
- explicit `large_oneoff` expense `900`
- planned template amount different from actual, e.g. `700`

- [x] **Step 2: Add required edge tests**

In the same file, add tests for:

- `large_oneoff` included in `total_spent`
- `large_oneoff` excluded from daily projection base
- paid planned uses actual linked expense amount
- large planned payment is not double-counted
- visual partition sums after rounding
- outside-budget block is hidden when no separate model exists

- [x] **Step 3: Verify accounting tests fail**

Run: `node --test apps/api/test/reportService.test.js`

Expected: FAIL because report service does not exist.

- [x] **Step 4: Add repository report data queries**

Implement repository methods for report service:

```js
async listExpensesForReportPeriod(userId, bounds) {}
async listPaidPlannedPaymentsForReportPeriod(userId, bounds) {}
async listPlannedOccurrencesForReportPeriod(userId, bounds, timeZone) {}
async listBudgetTopupsForReportPeriod(userId, bounds) {}
async getMonthBaselineForPeriod(userId, monthKey) {}
async hasMeaningfulReportActivity(userId, period, bounds, since) {}
```

Keep paid planned totals joined through `planned_expense_payments -> expenses.amount_base`.

- [x] **Step 5: Implement minimal report service metrics**

Export:

```js
export function createReportService({ repository, sendMessage, miniAppUrl, now }) {}
export function buildReportMetrics(input) {}
export function roundPartitionForDisplay(input) {}
```

Derive:

```js
totalSpent = sum(expenses.amount_base) + monthBaseline
plannedPaidTotal = sum(actual linked paid planned expense amount_base)
regularTotal = totalSpent - plannedPaidTotal
largeTotal = sum(expenses where budget_impact === "large_oneoff" or display threshold)
dailyProjectionBase = totalSpent - plannedPaidTotal - explicitLargeOneOffTotal
```

- [x] **Step 6: Run accounting tests green**

Run: `node --test apps/api/test/reportService.test.js`

Expected: PASS.

## Task 4: Report Formatting And Keyboards

**Files:**
- Create: `apps/api/src/reportFormat.js`
- Create: `apps/api/src/reportKeyboards.js`
- Test: `apps/api/test/reportFormat.test.js`
- Test: `apps/api/test/reportKeyboards.test.js`

- [x] **Step 1: Write failing format tests**

Create tests for:

- RU weekly report
- EN weekly report
- RU monthly report
- EN monthly report
- hidden empty planned/large/topup/committed/outside-budget blocks
- large subtotal shown when large exists
- planned unpaid due date shown
- no empty headers

- [x] **Step 2: Verify format tests fail**

Run: `node --test apps/api/test/reportFormat.test.js apps/api/test/reportKeyboards.test.js`

Expected: FAIL because files do not exist.

- [x] **Step 3: Implement formatter**

Export:

```js
export function formatWeeklyReport(report, options = {}) {}
export function formatMonthlyReport(report, options = {}) {}
export function formatReportMoney(value, currency, language) {}
```

Use existing currency rounding rules: THB/RUB/IDR/BYN whole units, USD/EUR/GEL cents.

- [x] **Step 4: Implement report keyboards**

Export:

```js
export function weeklyReportKeyboard(miniAppUrl, telegramUserId, periodKey, language) {}
export function monthlyReportKeyboard(miniAppUrl, telegramUserId, periodKey, language) {}
```

Weekly buttons:

- RU `Открыть неделю`, `Добавить трату`
- EN `Open week`, `Add expense`

Monthly buttons:

- RU `Открыть месяц`, `Бюджет на новый месяц`
- EN `Open month`, `New month budget`

- [x] **Step 5: Run format/keyboards tests green**

Run: `node --test apps/api/test/reportFormat.test.js apps/api/test/reportKeyboards.test.js`

Expected: PASS.

## Task 5: Delivery, Scheduler, Backfill

**Files:**
- Create: `apps/api/src/reportScheduler.js`
- Create: `apps/api/scripts/backfill-report.js`
- Modify: `apps/api/src/reportService.js`
- Modify: `apps/api/src/server.js`
- Modify: `package.json`
- Test: `apps/api/test/reportScheduler.test.js`
- Test: `apps/api/test/reportService.test.js`

- [x] **Step 1: Write failing scheduler tests**

Cover:

- Monday 09:00-14:00 local weekly gate
- first day 09:00-14:00 local monthly gate
- monthly and weekly both send when the 1st is Monday
- monthly sends before weekly
- duplicate delivery is skipped
- dry-run sends nothing
- 403 marks user blocked and records failed/skipped delivery

- [x] **Step 2: Verify scheduler tests fail**

Run: `node --test apps/api/test/reportScheduler.test.js apps/api/test/reportService.test.js`

Expected: FAIL because scheduler/backfill delivery is not implemented.

- [x] **Step 3: Implement report service delivery**

Service methods:

```js
async runDueReports({ dryRun = false } = {}) {}
async sendReportForUser(user, reportType, period, options = {}) {}
async backfillMonthlyReport(periodKey, { dryRun = true, force = false } = {}) {}
```

Write app events:

```text
weekly_report_generated
weekly_report_sent
weekly_report_failed
weekly_report_skipped
monthly_report_generated
monthly_report_sent
monthly_report_failed
monthly_report_skipped
```

- [x] **Step 4: Implement scheduler wrapper**

Export `createReportScheduler({ enabled, reportService, intervalMs, timerApi, logger })` with `start`, `stop`, and `tick`.

- [x] **Step 5: Wire server**

Replace `startWeeklyReportScheduler()` with `createReportScheduler(...)`. Keep old exports only if necessary for compatibility tests, then migrate tests to the new service.

- [x] **Step 6: Implement backfill script**

Add `reports:backfill` script:

```json
"reports:backfill": "node --env-file=.env apps/api/scripts/backfill-report.js"
```

The command must default to dry-run and require explicit `--send` for real delivery.

- [x] **Step 7: Run scheduler/backfill tests green**

Run: `node --test apps/api/test/reportScheduler.test.js apps/api/test/reportService.test.js`

Expected: PASS.

## Task 6: Documentation And Release Notes

**Files:**
- Modify: `docs/DOMAIN_RULES.md`
- Modify: `docs/PRODUCT_CONTEXT.md`
- Modify: `docs/TESTING_GUIDE.md`
- Optional: `docs/DECISIONS.md` only if implementation creates a surprising irreversible trade-off.

- [x] **Step 1: Update domain docs**

Document:

- Report Telegram message is a snapshot at send time.
- Mini App remains live recalculation.
- Large one-off report semantics match dashboard semantics.
- Outside-budget report block is hidden until a separate existing model supplies it.

- [x] **Step 2: Update testing guide**

Add report test pointers: periods, delivery idempotency, planned actual amounts, topups, large one-offs, formatting.

- [x] **Step 3: Decide whether ADR is needed**

Skip ADR unless the implementation introduces a hard-to-reverse, surprising trade-off. Expected answer: no ADR; this extends existing patterns.

## Task 7: Full Verification And PR

**Files:**
- All touched files.

- [x] **Step 1: Run focused tests**

Run:

```powershell
node --test apps/api/test/reportPeriods.test.js
node --test apps/api/test/reportService.test.js
node --test apps/api/test/reportFormat.test.js
node --test apps/api/test/reportKeyboards.test.js
node --test apps/api/test/reportScheduler.test.js
node --test apps/api/test/repository.test.js --test-name-pattern report
node --test apps/api/test/db.test.js
```

- [x] **Step 2: Run full suite**

Run:

```powershell
npm test
```

- [x] **Step 3: Review diff**

Run:

```powershell
git diff --check
git diff
```

- [x] **Step 4: Commit**

Use a focused message:

```powershell
git add apps/api docs package.json
git commit -m "feat: add weekly and monthly reports"
```

- [ ] **Step 5: Push branch**

Run:

```powershell
git push -u origin codex/reports-weekly-monthly
```

- [ ] **Step 6: Open draft PR**

PR body must include:

- Summary
- Changed areas
- Docs checked/updated
- Tests run
- DB/prod impact and rollback/forward-fix plan
- Release notes impact
- Screenshots: not applicable unless UI changed
- Open assumptions
- `## User Release Notes`

Release notes:

```md
## User Release Notes

- Weekly reports now arrive on Monday morning for the previous completed week.
- Added monthly reports for the previous closed month.
- Reports now include planned payments, large expenses, and budget top-ups without double-counting.
```
