# Planned Expense Archive And Safe Recreate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lazy read-only archive of disabled planned expenses and a safe recreate action that creates an independent plan whose obligations begin on a user-local start date.

**Architecture:** Keep lifecycle writes in the repository and expose separate archive and recreate HTTP contracts. Add one pure server period-date generator so dashboard, reserve, reports, Pay, and disable impact share `starts_on` semantics; keep the Mini App helper as a tested compatibility fallback. Treat database commit and HTTP `201` as irreversible success boundaries, with best-effort analytics and separately reported UI synchronization failures.

**Tech Stack:** Node.js ESM, PostgreSQL 17-compatible additive migrations, `pg`, Node built-in test runner, browser JavaScript Mini App, HTML/CSS, disposable local Postgres.

---

## File Map

- Create `apps/api/migrations/012_planned_expense_starts_on.sql`: additive nullable local-date column.
- Create `apps/api/src/plannedOccurrenceDates.js`: pure recurrence generation and `starts_on` filtering by local date key.
- Create `apps/api/test/plannedOccurrenceDates.test.js`: exhaustive recurrence/start-boundary unit tests.
- Modify `apps/api/src/repository.js`: canonical occurrence consumers, archive query, recreate transaction, transaction-safe reserve validation, safe event boundary.
- Modify `apps/api/src/server.js`: archive and recreate routes with exact status/error contracts.
- Modify `apps/api/test/repository.test.js`: repository archive/recreate/financial/snapshot tests.
- Modify `apps/api/test/security.test.js`: source-level route/auth/response contract tests.
- Modify `apps/api/test/budgetReserveIntegration.test.js`: live reserve and opening-snapshot regressions.
- Modify `apps/api/test/reportService.test.js`: unpaid pre-start versus factual paid-history regressions.
- Modify `apps/api/integration/postgres-smoke.js`: migration ledger plus real archive/recreate transaction flow.
- Create `apps/miniapp/src/plannedArchive.js`: pure archive state, invalidation, pluralization, and row-view helpers.
- Create `apps/miniapp/test/plannedArchive.test.js`: lazy loading, cache, invalidation, and RU/EN view tests.
- Create `apps/miniapp/src/plannedRecreate.js`: pure recreate request/commit/synchronization interaction.
- Create `apps/miniapp/test/plannedRecreate.test.js`: double-submit and post-201 synchronization-boundary tests.
- Modify `apps/miniapp/src/planned.js` and `apps/miniapp/test/planned.test.js`: compatibility `starts_on` filter.
- Modify `apps/miniapp/src/formatters.js` and `apps/miniapp/test/formatters.test.js`: user-timezone local date key.
- Modify `apps/miniapp/src/plannedDisable.js` and `apps/miniapp/test/plannedDisable.test.js`: archive invalidation after ordinary disable.
- Modify `apps/miniapp/src/app.js`: archive state/rendering, explicit form modes, recreate wiring, refresh warnings.
- Modify `apps/miniapp/src/index.html`, `apps/miniapp/src/styles.css`, `apps/miniapp/src/i18n.js`: compact localized archive and recreate form.
- Modify `apps/miniapp/test/i18n.test.js` and `apps/miniapp/test/smokeAssets.test.js`: localization and DOM/source contracts.
- Modify `CONTEXT.md`, `docs/DOMAIN_RULES.md`, `docs/DECISIONS.md`, `docs/UI_PRINCIPLES.md`, and `docs/TESTING_GUIDE.md`: stable domain, UI, and verification rules.

### Task 1: Add The Start-Date Migration And Pure Canonical Date Generator

**Files:**
- Create: `apps/api/migrations/012_planned_expense_starts_on.sql`
- Create: `apps/api/src/plannedOccurrenceDates.js`
- Create: `apps/api/test/plannedOccurrenceDates.test.js`

- [x] **Step 1: Write failing pure occurrence tests**

Create `apps/api/test/plannedOccurrenceDates.test.js` with table-driven assertions for legacy `NULL`, weekly, monthly, twice-monthly, one-off, clamped month end, future start, and invalid dates:

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizePlannedDateKey,
  plannedOccurrenceDateKeysForPeriod
} from "../src/plannedOccurrenceDates.js";

test("preserves legacy monthly occurrence keys when starts_on is null", () => {
  assert.deepEqual(
    plannedOccurrenceDateKeysForPeriod({ recurrence: "monthly", due_day: 31, starts_on: null }, "2026-02"),
    ["2026-02-28"]
  );
});

test("filters weekly keys before starts_on and restores the full next month", () => {
  const plan = { recurrence: "weekly", weekday: 3, starts_on: "2026-07-23" };
  assert.deepEqual(plannedOccurrenceDateKeysForPeriod(plan, "2026-07"), ["2026-07-29"]);
  assert.deepEqual(plannedOccurrenceDateKeysForPeriod(plan, "2026-08"), ["2026-08-05", "2026-08-12", "2026-08-19", "2026-08-26"]);
});

test("keeps only the second twice-monthly key when start is between due days", () => {
  assert.deepEqual(
    plannedOccurrenceDateKeysForPeriod(
      { recurrence: "twice_monthly", due_days: [5, 20], starts_on: "2026-07-12" },
      "2026-07"
    ),
    ["2026-07-20"]
  );
});

test("excludes one-off before start and includes one-off on start", () => {
  assert.deepEqual(plannedOccurrenceDateKeysForPeriod({ recurrence: "one_off", due_date: "2026-07-19", starts_on: "2026-07-20" }, "2026-07"), []);
  assert.deepEqual(plannedOccurrenceDateKeysForPeriod({ recurrence: "one_off", due_date: "2026-07-20", starts_on: "2026-07-20" }, "2026-07"), ["2026-07-20"]);
});

test("normalizes only real YYYY-MM-DD calendar dates", () => {
  assert.equal(normalizePlannedDateKey("2026-02-28"), "2026-02-28");
  assert.equal(normalizePlannedDateKey("2026-02-30"), null);
  assert.equal(normalizePlannedDateKey("not-a-date"), null);
});
```

Add the remaining boundary cases as a table:

```js
for (const scenario of [
  { name: "monthly due before start", plan: { recurrence: "monthly", due_day: 10, starts_on: "2026-07-20" }, period: "2026-07", expected: [] },
  { name: "monthly due after start", plan: { recurrence: "monthly", due_day: 25, starts_on: "2026-07-20" }, period: "2026-07", expected: ["2026-07-25"] },
  { name: "start after both due days", plan: { recurrence: "twice_monthly", due_days: [5, 20], starts_on: "2026-07-21" }, period: "2026-07", expected: [] },
  { name: "future start", plan: { recurrence: "monthly", due_day: 25, starts_on: "2026-08-01" }, period: "2026-07", expected: [] },
  { name: "clamped duplicates", plan: { recurrence: "twice_monthly", due_days: [30, 31] }, period: "2026-02", expected: ["2026-02-28"] },
  { name: "one_time alias", plan: { recurrence: "one_time", due_date: "2026-07-22" }, period: "2026-07", expected: ["2026-07-22"] }
]) {
  test(scenario.name, () => assert.deepEqual(
    plannedOccurrenceDateKeysForPeriod(scenario.plan, scenario.period),
    scenario.expected
  ));
}

test("accepts a real leap day and rejects a non-leap day", () => {
  assert.equal(normalizePlannedDateKey("2028-02-29"), "2028-02-29");
  assert.equal(normalizePlannedDateKey("2026-02-29"), null);
});
```

- [x] **Step 2: Run the new test and verify RED**

Run:

```powershell
npm.cmd test -- apps/api/test/plannedOccurrenceDates.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `plannedOccurrenceDates.js`.

- [x] **Step 3: Implement the pure date-key module**

Create `apps/api/src/plannedOccurrenceDates.js`:

```js
export function plannedOccurrenceDateKeysForPeriod(item, period) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period ?? ""));
  if (!match) return [];
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || month < 1 || month > 12) return [];

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let keys = [];
  const recurrence = item?.recurrence === "one_time" ? "one_off" : item?.recurrence;

  if (recurrence === "weekly") {
    const target = normalizeWeekday(item?.weekday);
    for (let day = 1; day <= daysInMonth; day += 1) {
      const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
      if (weekday === target) keys.push(dateKey(year, month, day));
    }
  } else if (recurrence === "one_off") {
    const dueDate = normalizePlannedDateKey(item?.due_date);
    if (dueDate?.slice(0, 7) === period) keys = [dueDate];
  } else {
    const rawDays = Array.isArray(item?.due_days) && item.due_days.length
      ? item.due_days
      : [item?.due_day ?? 1];
    const days = [...new Set(rawDays
      .map(Number)
      .filter((day) => Number.isInteger(day) && day >= 1)
      .map((day) => Math.min(day, daysInMonth)))]
      .sort((left, right) => left - right);
    keys = days.map((day) => dateKey(year, month, day));
  }

  const startsOn = normalizePlannedDateKey(item?.starts_on);
  return startsOn ? keys.filter((key) => key >= startsOn) : keys;
}

export function normalizePlannedDateKey(value) {
  if (value == null || value === "") return null;
  const raw = value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === day
    ? dateKey(year, month, day)
    : null;
}

function normalizeWeekday(value) {
  const weekday = Number(value);
  return Number.isInteger(weekday) && weekday >= 1 && weekday <= 7 ? weekday : 1;
}

function dateKey(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
```

- [x] **Step 4: Add the additive migration**

Create `apps/api/migrations/012_planned_expense_starts_on.sql`:

```sql
ALTER TABLE planned_expenses
ADD COLUMN IF NOT EXISTS starts_on DATE;
```

Do not edit `001_initial.sql`, add an index, or backfill existing rows.

- [x] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
npm.cmd test -- apps/api/test/plannedOccurrenceDates.test.js
```

Expected: all canonical date-key tests pass.

- [ ] **Step 6: Commit the pure occurrence foundation**

```powershell
git add apps/api/migrations/012_planned_expense_starts_on.sql apps/api/src/plannedOccurrenceDates.js apps/api/test/plannedOccurrenceDates.test.js
git commit -m "feat: add planned expense start dates"
```

### Task 2: Route Every Server Calculation Through Canonical Occurrences

**Files:**
- Modify: `apps/api/src/repository.js:1-20, 2834, 3938-3948, 4032, 4118-4173, 4238-4388`
- Modify: `apps/api/test/repository.test.js`
- Modify: `apps/api/test/budgetReserveIntegration.test.js`
- Modify: `apps/api/test/reportService.test.js`

- [ ] **Step 1: Write failing financial regression tests**

Add repository/budget/report cases using a weekly plan with `starts_on: "2026-07-23"` in `Asia/Bangkok` and a second boundary in `America/New_York`:

```js
assert.equal(currentDashboard.snapshot.plannedRemaining, 1000);
assert.equal(currentDashboard.snapshot.plannedThisWeek, 0);
assert.equal(nextMonthDashboard.snapshot.plannedRemaining, 4000);
assert.equal(currentDashboard.snapshot.dayPlanLimit, savedDayPlanLimit);
assert.ok(!report.plannedPayments.some((item) => item.dueDate < "2026-07-23" && !item.paid));
```

Add Pay assertions that `2026-07-22` throws `invalid_occurrence`, `2026-07-29` is accepted when due, and a valid historical payment link before `starts_on` remains included in factual paid totals. Add reserve-capacity and reserve-closure assertions using the same canonical count.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm.cmd test -- apps/api/test/repository.test.js apps/api/test/budgetReserveIntegration.test.js apps/api/test/reportService.test.js
```

Expected: pre-start dates still appear in remaining, reserve, report, or Pay calculations.

- [ ] **Step 3: Import and use the canonical generator**

At the top of `apps/api/src/repository.js` add:

```js
import {
  normalizePlannedDateKey,
  plannedOccurrenceDateKeysForPeriod
} from "./plannedOccurrenceDates.js";
```

Replace the independent month generators with these wrappers:

```js
function plannedDueDatesThisMonth(item, now, timeZone = userTimezone(item)) {
  return plannedOccurrenceDateKeysForPeriod(item, monthKey(now, timeZone))
    .map((key) => plannedLocalDate(key, timeZone))
    .filter(Boolean);
}

function plannedOccurrenceCountForPeriod(item, period) {
  return plannedOccurrenceDateKeysForPeriod(item, period).length;
}

function occurrencesThisMonth(item, now) {
  return plannedOccurrenceDateKeysForPeriod(item, monthKey(now, userTimezone(item))).length;
}
```

Keep `unpaidPlannedDueDatesThisMonth`, `calculatePlannedRemaining`, `calculatePlannedTotal`, `calculatePlannedThisWeek`, `reportUnpaidPlannedPayments`, `nextUnpaidOccurrenceDate`, and `resolveOccurrenceDate` consuming `plannedDueDatesThisMonth`. Remove now-unused `weekdaysInMonth`, `weeklyDueDatesThisMonth`, and count-only due-day helpers only after `rg` confirms zero callers.

- [ ] **Step 4: Preserve factual payment history explicitly**

Keep factual paid aggregates driven by valid `planned_expense_payments` joined to same-user `expenses`. Do not filter existing payment rows by `starts_on`. In `plannedObligationsForPeriod`, apply canonical counts only to active scheduled obligations; inactive plans use every valid paid link rather than capping factual count by the filtered schedule:

```js
return roundMoney(plansResult.rows.reduce((sum, item) => {
  const scheduledCount = plannedOccurrenceCountForPeriod(item, period);
  const validPaidCount = Number(item.paid_count ?? 0);
  const includedCount = item.active === false ? validPaidCount : scheduledCount;
  return sum + Number(item.amount_base) * includedCount;
}, 0));
```

- [ ] **Step 5: Run focused tests and verify GREEN**

```powershell
npm.cmd test -- apps/api/test/plannedOccurrenceDates.test.js apps/api/test/repository.test.js apps/api/test/budgetReserveIntegration.test.js apps/api/test/reportService.test.js
```

Expected: all selected suites pass, including PR #122 snapshot and paid-history cases.

- [ ] **Step 6: Commit canonical server consumption**

```powershell
git add apps/api/src/repository.js apps/api/test/repository.test.js apps/api/test/budgetReserveIntegration.test.js apps/api/test/reportService.test.js
git commit -m "fix: unify planned occurrence calculations"
```

### Task 3: Add The Read-only Archive Repository And API

**Files:**
- Modify: `apps/api/src/repository.js:2720-2724, 3724-3760, 3859-3905`
- Modify: `apps/api/src/server.js:377-410`
- Modify: `apps/api/test/repository.test.js`
- Modify: `apps/api/test/security.test.js`

- [ ] **Step 1: Write failing archive repository tests**

Add tests that capture SQL and returned rows:

```js
const archived = await repo.listArchivedPlannedExpensesForTelegramUser(100);
assert.deepEqual(archived.map((item) => item.id), [9, 7, 3]);
assert.equal(archived[0].active, false);
assert.equal(archived[0].paid_count, 2);
assert.equal(archived[0].paid_amount_base, 1750);
assert.equal(archived[0].display.paid_amount, 53.62);
assert.equal(archived.at(-1).disabled_at, null);
```

Assert the query contains ownership isolation, `active = false`, `ORDER BY disabled_at DESC NULLS LAST, planned_expenses.id DESC`, same-user expense ownership, and de-duplication by `paid_key`. Cover orphan and foreign expense links with zero contribution.

- [ ] **Step 2: Run repository tests and verify RED**

```powershell
npm.cmd test -- apps/api/test/repository.test.js
```

Expected: FAIL because `listArchivedPlannedExpensesForTelegramUser` does not exist.

- [ ] **Step 3: Implement the archive query and mapping**

Add `listArchivedPlannedExpensesForTelegramUser` to the repository. Use a CTE that selects one valid row per `(planned_expense_id, paid_key)` before aggregation:

```sql
WITH valid_payments AS (
  SELECT DISTINCT ON (pep.planned_expense_id, pep.paid_key)
         pep.planned_expense_id, pep.paid_key, e.amount_base
  FROM planned_expense_payments pep
  JOIN planned_expenses source ON source.id = pep.planned_expense_id
  JOIN expenses e ON e.id = pep.expense_id AND e.user_id = source.user_id
  ORDER BY pep.planned_expense_id, pep.paid_key, pep.id
), paid AS (
  SELECT planned_expense_id,
         COUNT(*)::int AS paid_count,
         COALESCE(SUM(amount_base), 0)::float AS paid_amount_base
  FROM valid_payments
  GROUP BY planned_expense_id
)
SELECT planned_expenses.*,
       users.timezone AS user_timezone,
       users.base_currency AS user_base_currency,
       users.display_currency AS user_display_currency,
       users.usd_thb_rate AS user_usd_thb_rate,
       COALESCE(paid.paid_count, 0)::int AS paid_count,
       COALESCE(paid.paid_amount_base, 0)::float AS paid_amount_base
FROM planned_expenses
JOIN users ON users.id = planned_expenses.user_id
LEFT JOIN paid ON paid.planned_expense_id = planned_expenses.id
WHERE users.telegram_user_id = $1 AND planned_expenses.active = false
ORDER BY planned_expenses.disabled_at DESC NULLS LAST, planned_expenses.id DESC
```

Map without returning the temporary user aliases:

```js
return result.rows.map((row) => {
  const {
    user_timezone, user_base_currency, user_display_currency, user_usd_thb_rate,
    ...planned
  } = row;
  const user = {
    timezone: user_timezone,
    base_currency: user_base_currency,
    display_currency: user_display_currency,
    usd_thb_rate: user_usd_thb_rate
  };
  const mapped = withDisplayPlanned(planned, user);
  mapped.display.paid_amount = displayFromBase(planned.paid_amount_base, user);
  return mapped;
});
```

- [ ] **Step 4: Write a failing archive route contract test**

In `apps/api/test/security.test.js`, assert `GET /api/planned-expenses/archive` appears before mutation routes, uses `resolveTelegramUserId`, calls only `listArchivedPlannedExpensesForTelegramUser`, and responds with:

```js
return sendJson(res, 200, { archivedPlannedExpenses });
```

- [ ] **Step 5: Implement the archive route**

Add to `apps/api/src/server.js`:

```js
if (req.method === "GET" && url.pathname === "/api/planned-expenses/archive") {
  const auth = apiSecurity.resolveTelegramUserId(req, url);
  if (auth.error) return sendJson(res, 400, { error: auth.error });
  const archivedPlannedExpenses = await repository.listArchivedPlannedExpensesForTelegramUser(auth.telegramUserId);
  return sendJson(res, 200, { archivedPlannedExpenses });
}
```

- [ ] **Step 6: Run archive tests and verify GREEN**

```powershell
npm.cmd test -- apps/api/test/repository.test.js apps/api/test/security.test.js
```

- [ ] **Step 7: Commit the archive API**

```powershell
git add apps/api/src/repository.js apps/api/src/server.js apps/api/test/repository.test.js apps/api/test/security.test.js
git commit -m "feat: add planned expense archive API"
```

### Task 4: Implement Transactional Safe Recreate And Exact Error Precedence

**Files:**
- Modify: `apps/api/src/repository.js:2724-2805, 3960-4050`
- Modify: `apps/api/src/server.js:400-450`
- Modify: `apps/api/test/repository.test.js`
- Modify: `apps/api/test/security.test.js`

- [ ] **Step 1: Write failing transaction tests**

Create a test fixture whose pool exposes `query()` for preflight and `connect()` for a client that records `BEGIN`, `FOR UPDATE`, reserve reads, active-plan reads, INSERT, `COMMIT`, and `ROLLBACK`. Cover:

```js
const first = await repo.recreatePlannedExpense(100, 7, input, "2026-07-23", now);
const second = await repo.recreatePlannedExpense(100, 7, input, "2026-07-23", now);
assert.notEqual(first.id, second.id);
assert.equal(first.active, true);
assert.equal(first.starts_on, "2026-07-23");
assert.equal(source.active, false);
assert.equal(source.disabled_at.toISOString(), originalDisabledAt.toISOString());
assert.equal(copiedPayments.length, 0);
assert.equal(insertedExpenses.length, 0);
```

Add missing/foreign/active source cases with malformed payload and malformed `startsOn`; all must return the repository not-found outcome before exchange-rate resolution. Add one-off missing/invalid/before-start codes.

- [ ] **Step 2: Add the reserve rollback and event-boundary tests**

For an active reserve conflict assert:

```js
await assert.rejects(operation, { code: "reserve_conflicts_with_planned_change" });
assert.ok(statements.includes("ROLLBACK"));
assert.ok(!statements.includes("COMMIT"));
assert.equal(newPlanRows.length, 0);
assert.equal(events.length, 0);
```

Override `repo.recordAppEvent` to throw after `COMMIT`; assert the method still returns the new plan and only one plan row exists. Assert event metadata contains exactly `{ source: "miniapp", mode: "recreate" }` and no financial/source IDs.

- [ ] **Step 3: Run repository tests and verify RED**

```powershell
npm.cmd test -- apps/api/test/repository.test.js
```

Expected: FAIL because recreate and transaction-safe reserve validation do not exist.

- [ ] **Step 4: Add a transaction-safe reserve helper**

Keep legacy callers stable and add an explicit queryable variant:

```js
async function assertPlannedMutationCapacityWithQueryable(queryable, user, changedPlan, changedPlanId) {
  const reserveResult = await queryable.query(
    `SELECT * FROM monthly_reserve_instances
     WHERE user_id = $1 AND status = 'active'
     ORDER BY period DESC
     LIMIT 1`,
    [user.id]
  );
  const reserve = reserveResult.rows[0];
  if (!reserve) return;
  const plansResult = await queryable.query(
    `SELECT * FROM planned_expenses WHERE user_id = $1 AND active = true`,
    [user.id]
  );
  const plans = plansResult.rows.filter((item) => String(item.id) !== String(changedPlanId));
  plans.push(changedPlan);
  const plannedAmount = roundMoney(plans.reduce((sum, item) => (
    sum + Number(item.amount_base) * plannedOccurrenceCountForPeriod(item, reserve.period)
  ), 0));
  const capacity = validateReserveCapacity({
    budgetAmount: reserve.budget_amount,
    plannedAmount,
    reserveAmount: reserve.reserve_amount
  });
  if (!capacity.valid) throw codedError("reserve_conflicts_with_planned_change", "reserve_conflicts_with_planned_change");
}
```

The existing `assertPlannedMutationCapacity` may retain its test-double guard, but recreate must call `assertPlannedMutationCapacityWithQueryable(client, ...)` so every reserve query and INSERT uses the same transaction client.

- [ ] **Step 5: Implement source preflight, locked recheck, validation, insert, and safe event**

Add `recreatePlannedExpense` with this control shape:

```js
async recreatePlannedExpense(telegramUserId, archivedId, input, startsOn, now = new Date()) {
  const source = await readOwnedArchivedPlannedExpense(pool, telegramUserId, archivedId, false);
  if (!source) return null;

  const planned = normalizePlannedExpense(input);
  const startsOnKey = normalizePlannedDateKey(startsOn);
  if (!startsOnKey) throw codedError("Invalid planned start date", "invalid_planned_start_date");
  const todayKey = localDayKey(now, userTimezone(source));
  if (startsOnKey < todayKey) throw codedError("Planned start date is in the past", "planned_start_date_in_past");
  const dueDateKey = normalizePlannedDateKey(planned.due_date);
  if (planned.recurrence === "one_off" && !dueDateKey) throw codedError("Invalid planned due date", "invalid_planned_due_date");
  if (planned.recurrence === "one_off" && dueDateKey < startsOnKey) throw codedError("Planned due date is before start", "planned_due_date_before_start");
  const money = await buildMoneyAmounts(exchangeRates, planned.amount, planned.currency, now, source);

  const client = await pool.connect();
  let created = null;
  try {
    await client.query("BEGIN");
    const locked = await readOwnedArchivedPlannedExpense(client, telegramUserId, archivedId, true);
    if (!locked) {
      await client.query("ROLLBACK");
      return null;
    }
    const candidate = { ...planned, amount_base: money.amountBase, active: true, starts_on: startsOnKey };
    await assertPlannedMutationCapacityWithQueryable(client, locked, candidate, null);
    const result = await client.query(
      `INSERT INTO planned_expenses (
         user_id, amount, currency, amount_base, description, category_slug, tags,
         recurrence, due_day, due_days, weekday, due_date, starts_on, active
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true)
       RETURNING *`,
      [locked.user_id, planned.amount, planned.currency, money.amountBase, planned.description,
       planned.category_slug, planned.tags, planned.recurrence, planned.due_day,
       planned.due_days, planned.weekday, planned.due_date, startsOnKey]
    );
    created = result.rows[0] ?? null;
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
    throw error;
  } finally {
    client.release();
  }
  if (created) {
    try {
      await this.recordAppEvent(created.user_id, "planned_expense_created", { source: "miniapp", mode: "recreate" });
    } catch (error) {
      console.warn("[repository] recreate event failed after commit", { message: error?.message });
    }
  }
  return created;
}
```

Define the source helper once and append `FOR UPDATE` only for the transaction recheck:

```js
async function readOwnedArchivedPlannedExpense(queryable, telegramUserId, archivedId, lock) {
  const result = await queryable.query(
    `SELECT planned_expenses.*,
            users.base_currency,
            users.display_currency,
            users.usd_thb_rate,
            users.timezone
     FROM planned_expenses
     JOIN users ON users.id = planned_expenses.user_id
     WHERE planned_expenses.id = $1
       AND users.telegram_user_id = $2
       AND planned_expenses.active = false
     ${lock ? "FOR UPDATE" : ""}`,
    [archivedId, telegramUserId]
  );
  return result.rows[0] ?? null;
}
```

- [ ] **Step 6: Write and implement the recreate route contract**

Add security assertions, then implement before the ordinary item matcher:

```js
const recreateMatch = url.pathname.match(/^\/api\/planned-expenses\/(\d+)\/recreate$/);
if (req.method === "POST" && recreateMatch) {
  const body = await readJson(req);
  const auth = apiSecurity.resolveTelegramUserId(req, url, body);
  if (auth.error) return sendJson(res, 400, { error: auth.error });
  try {
    const plannedExpense = await repository.recreatePlannedExpense(
      auth.telegramUserId,
      Number(recreateMatch[1]),
      body.plannedExpense,
      body.startsOn
    );
    if (!plannedExpense) return sendJson(res, 404, { error: "planned_expense_not_found" });
    return sendJson(res, 201, { plannedExpense });
  } catch (error) {
    if (["invalid_planned_start_date", "planned_start_date_in_past", "invalid_planned_due_date", "planned_due_date_before_start"].includes(error.code)) {
      return sendJson(res, 400, { error: error.code });
    }
    if (error.code === "reserve_conflicts_with_planned_change") return sendJson(res, 409, { error: error.code });
    throw error;
  }
}
```

- [ ] **Step 7: Run focused tests and verify GREEN**

```powershell
npm.cmd test -- apps/api/test/repository.test.js apps/api/test/security.test.js apps/api/test/budgetReserveIntegration.test.js
```

- [ ] **Step 8: Commit transactional recreate**

```powershell
git add apps/api/src/repository.js apps/api/src/server.js apps/api/test/repository.test.js apps/api/test/security.test.js apps/api/test/budgetReserveIntegration.test.js
git commit -m "feat: recreate archived planned expenses safely"
```

### Task 5: Align Mini App Occurrences And User-Timezone Start Defaults

**Files:**
- Modify: `apps/miniapp/src/planned.js:120-165`
- Modify: `apps/miniapp/test/planned.test.js`
- Modify: `apps/miniapp/src/formatters.js:45-110`
- Modify: `apps/miniapp/test/formatters.test.js`

- [ ] **Step 1: Write failing client compatibility tests**

Add the same weekly/monthly/twice-monthly/one-off date-key examples used by the server and prove `active = false` remains empty and `starts_on = null` remains unchanged:

```js
assert.deepEqual(
  buildPlannedOccurrences({ recurrence: "weekly", weekday: 3, starts_on: "2026-07-23" }, new Date(2026, 6, 15))
    .map((item) => item.occurrence_date),
  ["2026-07-29"]
);
```

In formatter tests inject `2026-07-22T18:30:00.000Z` and assert `Asia/Bangkok` gives `2026-07-23` while `America/New_York` gives `2026-07-22`.

- [ ] **Step 2: Run tests and verify RED**

```powershell
npm.cmd test -- apps/miniapp/test/planned.test.js apps/miniapp/test/formatters.test.js
```

- [ ] **Step 3: Filter client keys and add a timezone formatter**

In `buildPlannedOccurrences`, after recurrence generation and before paid mapping:

```js
const startsOn = /^\d{4}-\d{2}-\d{2}$/.test(String(item.starts_on ?? "")) ? String(item.starts_on) : null;
const eligibleDates = startsOn ? dates.filter((key) => key >= startsOn) : dates;
```

Use `eligibleDates` for legacy paid count and returned occurrence objects. Add to `formatters.js`:

```js
export function localDateKeyInTimeZone(value = new Date(), timeZone = "Asia/Bangkok") {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
```

- [ ] **Step 4: Run tests and verify GREEN**

```powershell
npm.cmd test -- apps/miniapp/test/planned.test.js apps/miniapp/test/formatters.test.js
```

- [ ] **Step 5: Commit client date compatibility**

```powershell
git add apps/miniapp/src/planned.js apps/miniapp/src/formatters.js apps/miniapp/test/planned.test.js apps/miniapp/test/formatters.test.js
git commit -m "fix: align planned start dates in mini app"
```

### Task 6: Build Lazy Archive State And Invalidate It After Disable

**Files:**
- Create: `apps/miniapp/src/plannedArchive.js`
- Create: `apps/miniapp/test/plannedArchive.test.js`
- Modify: `apps/miniapp/src/plannedDisable.js`
- Modify: `apps/miniapp/test/plannedDisable.test.js`
- Modify: `apps/miniapp/src/app.js:53-70, 80-125, 178-200, 1132-1225`
- Modify: `apps/miniapp/src/index.html:195-205`
- Modify: `apps/miniapp/src/styles.css:979-1050, 1218-1260, 1950-1985`
- Modify: `apps/miniapp/src/i18n.js`
- Modify: `apps/miniapp/test/i18n.test.js`
- Modify: `apps/miniapp/test/smokeAssets.test.js`

- [ ] **Step 1: Write failing archive state and presentation tests**

Create pure tests for idle/collapsed state, one in-flight load, loaded cache, retry after error, invalidation, and localized rows:

```js
const state = createPlannedArchiveState();
assert.deepEqual(state, { expanded: false, status: "idle", items: [], stale: false, error: null, inFlight: null });

const first = expandPlannedArchive(state, { load: loadArchive });
const second = expandPlannedArchive(state, { load: loadArchive });
assert.equal(requests, 1);
await Promise.all([first, second]);

invalidatePlannedArchive(state);
assert.equal(state.stale, true);
```

Test RU counts `1 оплата`, `2 оплаты`, `5 оплат`, EN singular/plural, and null date copy.

- [ ] **Step 2: Run archive tests and verify RED**

```powershell
npm.cmd test -- apps/miniapp/test/plannedArchive.test.js apps/miniapp/test/plannedDisable.test.js apps/miniapp/test/i18n.test.js apps/miniapp/test/smokeAssets.test.js
```

- [ ] **Step 3: Implement the pure archive state module**

Create `plannedArchive.js` with exported `createPlannedArchiveState`, `expandPlannedArchive`, `collapsePlannedArchive`, `invalidatePlannedArchive`, `archivePaymentCountKey`, and `buildArchivedPlanView`. `expandPlannedArchive` stores and returns the same `inFlight` promise, caches only success, and clears `inFlight` in `finally`:

```js
export async function expandPlannedArchive(state, { load }) {
  state.expanded = true;
  if (state.status === "loaded" && !state.stale) return state.items;
  if (state.inFlight) return state.inFlight;
  state.status = "loading";
  state.error = null;
  state.inFlight = Promise.resolve(load()).then((items) => {
    state.items = Array.isArray(items) ? items : [];
    state.status = "loaded";
    state.stale = false;
    return state.items;
  }).catch((error) => {
    state.status = "error";
    state.error = error;
    throw error;
  }).finally(() => { state.inFlight = null; });
  return state.inFlight;
}

export function invalidatePlannedArchive(state) {
  if (state.status === "loaded") state.stale = true;
  return state.expanded && state.status !== "idle";
}
```

- [ ] **Step 4: Add archive markup, localized keys, and compact styles**

After `#plannedExpenses` add the accessible collapsed structure:

```html
<section class="planned-archive" id="plannedArchiveBlock">
  <button type="button" class="planned-archive__toggle" id="plannedArchiveToggle"
          aria-expanded="false" aria-controls="plannedArchiveContent">
    <span data-i18n="plan.archiveTitle">Отключённые</span>
    <span aria-hidden="true">›</span>
  </button>
  <div class="planned-archive__content hidden" id="plannedArchiveContent">
    <div class="planned-archive__status" id="plannedArchiveStatus" role="status"></div>
    <div class="expense-list" id="plannedArchiveList"></div>
  </div>
</section>
```

Add mirrored RU/EN keys:

```js
"plan.archiveTitle": "Отключённые", // "Disabled plans"
"plan.archiveLoading": "Загружаю…", // "Loading…"
"plan.archiveEmpty": "Отключённых планов пока нет", // "No disabled plans yet"
"plan.archiveError": "Не удалось загрузить архив", // "Could not load disabled plans"
"plan.archiveRetry": "Повторить", // "Retry"
"plan.archiveDateUnavailable": "Дата отключения не сохранена", // "Disable date unavailable"
"plan.createAgain": "Создать снова", // "Create again"
"plan.startsOn": "Начать учитывать с", // "Start counting from"
"toast.plannedRecreated": "Новый план создан. Старый остался в архиве.", // "New plan created. The old plan remains archived."
"toast.plannedRefreshWarning": "План создан, но данные не обновились. Перезагрузите экран.", // "The plan was created, but the screen did not refresh. Reload it."
```

Add these payment-count keys: RU `plan.archivePaymentOne = "{count} сохранённая оплата"`, `plan.archivePaymentFew = "{count} сохранённые оплаты"`, `plan.archivePaymentMany = "{count} сохранённых оплат"`; EN `plan.archivePaymentOne = "{count} saved payment"` and both Few/Many as `"{count} saved payments"`. Style archived rows with wrapping title/amount and a single non-danger action:

```css
.planned-archive { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 10px; }
.planned-archive__toggle { width: 100%; display: flex; justify-content: space-between; align-items: center; }
.planned-archive__content { margin-top: 8px; }
.planned-archive .expense-row { align-items: flex-start; }
.planned-archive .expense-title, .planned-archive .expense-amount { overflow-wrap: anywhere; }
@media (max-width: 430px) {
  .planned-archive .expense-actions, .planned-archive .button-row { width: 100%; }
  .planned-archive .button-row button { width: 100%; }
}
```

- [ ] **Step 5: Wire lazy loading and rendering in `app.js`**

Initialize one archive state, bind the toggle once, and request only:

```js
api(`/api/planned-expenses/archive?telegramUserId=${encodeURIComponent(telegramUserId)}`)
```

Render loading, empty, error, or mapped rows from state. Do not call archive loading from `loadDashboard`.

Define the app-level refresh boundary used by disable and recreate:

```js
async function refreshPlannedArchive({ force = false } = {}) {
  if (!plannedArchiveState.expanded && !force) return plannedArchiveState.items;
  if (force) plannedArchiveState.stale = true;
  try {
    const items = await expandPlannedArchive(plannedArchiveState, {
      load: async () => {
        const data = await api(`/api/planned-expenses/archive?telegramUserId=${encodeURIComponent(telegramUserId)}`);
        return data.archivedPlannedExpenses ?? [];
      }
    });
    renderPlannedArchive();
    return items;
  } catch (error) {
    renderPlannedArchive();
    throw error;
  }
}

async function refreshArchiveAfterDisable() {
  const shouldRefresh = invalidatePlannedArchive(plannedArchiveState);
  if (shouldRefresh) await refreshPlannedArchive({ force: true });
}
```

- [ ] **Step 6: Extend ordinary disable with an optional post-dashboard callback**

Update `runPlannedDisable`:

```js
const result = await disableRequest(item.id);
await loadDashboard();
if (typeof afterDashboard === "function") await afterDashboard(result);
showResult(buildPlannedDisableResult(...));
```

In `app.js`, `afterDashboard` invalidates archive state; refresh immediately only when expanded, mark stale when loaded/collapsed, and do nothing when never loaded. Add tests for all three states and preserve the existing event order when the callback is absent.

- [ ] **Step 7: Run archive and disable tests and verify GREEN**

```powershell
npm.cmd test -- apps/miniapp/test/plannedArchive.test.js apps/miniapp/test/plannedDisable.test.js apps/miniapp/test/i18n.test.js apps/miniapp/test/smokeAssets.test.js
```

- [ ] **Step 8: Commit the lazy archive UI**

```powershell
git add apps/miniapp/src/plannedArchive.js apps/miniapp/src/plannedDisable.js apps/miniapp/src/app.js apps/miniapp/src/index.html apps/miniapp/src/styles.css apps/miniapp/src/i18n.js apps/miniapp/test/plannedArchive.test.js apps/miniapp/test/plannedDisable.test.js apps/miniapp/test/i18n.test.js apps/miniapp/test/smokeAssets.test.js
git commit -m "feat: show disabled planned expense archive"
```

### Task 7: Add Explicit Recreate Form Mode And Post-201 Synchronization Handling

**Files:**
- Create: `apps/miniapp/src/plannedRecreate.js`
- Create: `apps/miniapp/test/plannedRecreate.test.js`
- Modify: `apps/miniapp/src/app.js:1053-1125, 1164-1280, 1672-1700`
- Modify: `apps/miniapp/src/i18n.js`
- Modify: `apps/miniapp/test/i18n.test.js`
- Modify: `apps/miniapp/test/smokeAssets.test.js`

- [ ] **Step 1: Write failing pure recreate interaction tests**

Test cancelled/no request, pending double-submit, mutation failure preserving form, successful POST closing before refresh, and independent refresh warnings:

```js
const pending = runPlannedRecreate(dependencies);
assert.deepEqual(await runPlannedRecreate(dependencies), { status: "busy" });
assert.equal(postRequests, 1);

const result = await runPlannedRecreate({
  ...dependencies,
  recreateRequest: async () => ({ plannedExpense: { id: 42 } }),
  closeForm: () => events.push("closeForm"),
  loadDashboard: async () => { events.push("loadDashboard"); throw new Error("refresh_failed"); },
  refreshArchive: async () => events.push("refreshArchive"),
  showCreated: () => events.push("showCreated"),
  showRefreshWarning: () => events.push("showRefreshWarning")
});
assert.equal(result.status, "created_with_refresh_warning");
assert.equal(postRequests, 1);
assert.deepEqual(events.slice(0, 2), ["recreateRequest", "closeForm"]);
assert.ok(events.includes("showCreated"));
assert.ok(events.includes("showRefreshWarning"));
```

Repeat with archive refresh failing. Assert neither case reopens or re-enables the completed form. A new call requires a newly constructed form session.

- [ ] **Step 2: Run recreate tests and verify RED**

```powershell
npm.cmd test -- apps/miniapp/test/plannedRecreate.test.js apps/miniapp/test/smokeAssets.test.js
```

- [ ] **Step 3: Implement the pure interaction boundary**

Create `plannedRecreate.js`:

```js
export async function runPlannedRecreate({
  session, recreateRequest, closeForm, loadDashboard, refreshArchive,
  showCreated, showRefreshWarning
}) {
  if (session.busy || session.completed) return { status: "busy" };
  session.busy = true;
  try {
    const result = await recreateRequest();
    session.completed = true;
    closeForm();
    showCreated(result);
    const settled = await Promise.allSettled([loadDashboard(), refreshArchive()]);
    const refreshFailed = settled.some((entry) => entry.status === "rejected");
    if (refreshFailed) showRefreshWarning();
    return { status: refreshFailed ? "created_with_refresh_warning" : "created", result };
  } catch (error) {
    if (!session.completed) session.busy = false;
    throw error;
  }
}
```

The mutation error path restores the button and retains fields. The post-201 path never resets `completed`, never retries POST, and never throws a refresh failure as creation failure.

- [ ] **Step 4: Make form mode explicit**

Change the form signature and all callers:

```js
function renderPlannedForm(item = {}, {
  mode = "create",
  sourcePlannedExpenseId = null
} = {}) { /* render and bind exact mode */ }
```

Active edit buttons call `{ mode: "edit" }`; archive buttons call `{ mode: "recreate", sourcePlannedExpenseId: item.id }`; reset/close call create mode. Submit labels and headings come from mode, never `item.id`.

For recreate, render:

```html
<label>
  <span>${t("plan.startsOn")}</span>
  <input name="planned-starts_on" type="date" value="${startsOn}" min="${startsOn}" required />
</label>
```

Compute `startsOn` with `localDateKeyInTimeZone(new Date(), dashboardState.user.timezone)`. Clear source one-off `due_date` when it is `<= startsOn`.

Create one submission session per rendered form and define the close boundary:

```js
const submissionSession = { busy: false, completed: false };

function closeAndResetPlannedForm() {
  renderPlannedForm();
  document.querySelector("#plannedForm")?.classList.add("hidden");
}
```

- [ ] **Step 5: Route submit by mode without leaking source ID into PATCH**

Use one explicit dispatcher. Recreate uses the source-only route; ordinary modes retain their current contracts:

```js
if (mode === "recreate") {
  return runPlannedRecreate({
    session: submissionSession,
    recreateRequest: () => api(`/api/planned-expenses/${sourcePlannedExpenseId}/recreate`, {
      method: "POST",
      body: { telegramUserId, startsOn: input("planned-starts_on").value, plannedExpense: collectPlanned() }
    }),
    closeForm: closeAndResetPlannedForm,
    loadDashboard,
    refreshArchive: () => refreshPlannedArchive({ force: true }),
    showCreated: () => showToast(t("toast.plannedRecreated")),
    showRefreshWarning: () => showToast(t("toast.plannedRefreshWarning"))
  });
}
const plannedExpense = collectPlanned();
if (mode === "edit") {
  await api(`/api/planned-expenses/${item.id}`, {
    method: "PATCH",
    body: { telegramUserId, plannedExpense }
  });
  closeAndResetPlannedForm();
  await loadDashboard();
  showToast(t("toast.plannedSaved"));
  return;
}
await api("/api/planned-expenses", {
  method: "POST",
  body: { telegramUserId, plannedExpense }
});
closeAndResetPlannedForm();
await loadDashboard();
showToast(t("toast.plannedAdded"));
```

Never assign `sourcePlannedExpenseId` to `plannedId`. Keep ordinary create/edit error behavior unchanged.

- [ ] **Step 6: Run Mini App focused tests and verify GREEN**

```powershell
npm.cmd test -- apps/miniapp/test/plannedRecreate.test.js apps/miniapp/test/plannedArchive.test.js apps/miniapp/test/planned.test.js apps/miniapp/test/formatters.test.js apps/miniapp/test/i18n.test.js apps/miniapp/test/smokeAssets.test.js
```

- [ ] **Step 7: Commit recreate UX**

```powershell
git add apps/miniapp/src/plannedRecreate.js apps/miniapp/src/app.js apps/miniapp/src/i18n.js apps/miniapp/test/plannedRecreate.test.js apps/miniapp/test/i18n.test.js apps/miniapp/test/smokeAssets.test.js
git commit -m "feat: recreate disabled planned expenses"
```

### Task 8: Extend Disposable Postgres Coverage

**Files:**
- Modify: `apps/api/integration/postgres-smoke.js:20-35, 238-330`

- [ ] **Step 1: Update the expected migration ledger and add the real flow**

Extend the expected list through `012_planned_expense_starts_on.sql`. In the planned lifecycle smoke:

1. create an `Asia/Bangkok` user and weekly plan;
2. save multiple valid payments with factual `amount_base` values;
3. disable the plan and preserve the existing day snapshot;
4. read the archive and assert count/sum/source fields;
5. recreate with a mid-month `starts_on`;
6. assert new ID, active state, no copied payments, no expenses created by recreate;
7. assert pre-start weekly dates are absent from current remaining;
8. assert reserve capacity uses the same count;
9. assert live monthly values change, today's saved limit does not, and next local day reflects the new plan.

Use invented IDs and amounts already local to the disposable test suite; print no financial rows.

- [ ] **Step 2: Run the completed Postgres smoke**

```powershell
npm.cmd run test:integration:postgres
```

Expected: the safety guard confirms localhost and a database name containing `test`; migrations 001-012 apply idempotently; archive aggregates, recreate transaction, reserve, and snapshot assertions pass.

- [ ] **Step 3: Commit integration coverage**

```powershell
git add apps/api/integration/postgres-smoke.js
git commit -m "test: cover planned archive recreate in postgres"
```

### Task 9: Update Stable Documentation And Capture Mobile Evidence

**Files:**
- Modify: `docs/DOMAIN_RULES.md`
- Modify: `docs/DECISIONS.md`
- Modify: `docs/UI_PRINCIPLES.md`
- Modify: `docs/TESTING_GUIDE.md`
- Modify: `docs/superpowers/plans/2026-07-22-planned-expense-archive-recreate.md`

- [ ] **Step 1: Record the final domain rules**

Document these exact meanings:

- archive is read-only history and restore through `active = true` is forbidden;
- recreate inserts an independent row and never inherits payments;
- repeated intentional recreate is allowed without source linkage;
- `starts_on = NULL` is legacy behavior and non-null start filters only scheduled obligations;
- factual valid payment links remain factual even if earlier than `starts_on`;
- user timezone owns the calendar key;
- PR #122 opening-snapshot policy remains unchanged;
- post-commit analytics and post-201 refresh failures cannot turn successful creation into a retryable mutation error.

- [ ] **Step 2: Record compact archive UI and testing guidance**

Update `UI_PRINCIPLES.md` with collapsed-by-default lazy history, no archive controls other than Create again, explicit loading/empty/error states, and narrow-width wrapping. Update `TESTING_GUIDE.md` with migration 012, archive validity, transaction-client reserve validation, error precedence, synchronization boundary, and mobile screenshots.

- [ ] **Step 3: Run the local Mini App acceptance sandbox**

Use only the local disposable development database:

```powershell
npm.cmd run dev:reset
npm.cmd run dev:api
```

Create synthetic active plans through the local UI/API, pay and disable them through normal local flows, and include one local legacy row with `disabled_at = NULL` only in the disposable database. Do not use production data or production commands.

- [ ] **Step 4: Capture and review four screenshots**

Capture:

- RU expanded archive;
- EN expanded archive;
- RU `Создать снова` form;
- EN `Create again` form.

Check iPhone 11 and iPhone 14 Pro viewports, long synthetic description, large synthetic amount, null disable date, and multiple saved payments. Confirm no horizontal scroll, clipped text, overflowing buttons, or active controls on archived rows. Save screenshot paths for the draft PR body; do not commit secrets or real data.

- [ ] **Step 5: Mark only actually completed plan checkboxes**

Update this file checkbox-by-checkbox from command and visual evidence. Leave any unexecuted step unchecked and explain it in the PR rather than claiming completion.

- [ ] **Step 6: Commit docs and evidence references**

```powershell
git add docs/DOMAIN_RULES.md docs/DECISIONS.md docs/UI_PRINCIPLES.md docs/TESTING_GUIDE.md docs/superpowers/plans/2026-07-22-planned-expense-archive-recreate.md
git commit -m "docs: record planned archive recreate rules"
```

### Task 10: Verify The Complete Change And Open A Draft PR

**Files:**
- Review: all files changed from `origin/master...HEAD`

- [ ] **Step 1: Run all focused suites**

```powershell
npm.cmd test -- apps/api/test/plannedOccurrenceDates.test.js apps/api/test/repository.test.js apps/api/test/budgetReserveIntegration.test.js apps/api/test/reportService.test.js apps/api/test/security.test.js apps/miniapp/test/plannedArchive.test.js apps/miniapp/test/plannedRecreate.test.js apps/miniapp/test/plannedDisable.test.js apps/miniapp/test/planned.test.js apps/miniapp/test/formatters.test.js apps/miniapp/test/i18n.test.js apps/miniapp/test/smokeAssets.test.js
```

Expected: all focused tests pass.

- [ ] **Step 2: Run the full unit suite**

```powershell
npm.cmd test
```

Expected: zero failures; no real exchange-rate/model/network call is made.

- [ ] **Step 3: Run disposable Postgres integration**

```powershell
npm.cmd run test:integration:postgres
```

Expected: localhost/test safety guard passes, migrations 001-012 are recorded, and all smoke scenarios pass.

- [ ] **Step 4: Review scope and repository hygiene**

```powershell
git diff --check
git diff origin/master...HEAD --stat
git status --short
git log --oneline origin/master..HEAD
```

Confirm no production values, user data, `001_initial.sql` edits, source-plan linkage, idempotency key, archive restore, payment deletion, reminder change, dependency update, drive-by refactor, merge, or deploy.

- [ ] **Step 5: Perform a reviewer pass**

Use `requesting-code-review` and check the final diff against every spec heading, especially transaction-client reserve validation, 404 precedence, post-commit/post-201 boundaries, factual history, cache invalidation, and snapshot stability. Resolve only verified blockers and rerun affected tests.

- [ ] **Step 6: Push the branch and open a draft PR**

Push `codex/planned-expense-archive-recreate` and open a draft PR into `master`. The PR body must include:

- summary and changed areas;
- docs checked/updated;
- focused/full/Postgres commands and actual results;
- additive nullable `starts_on` impact, no backfill, and forward-fix policy;
- no production access or data writes;
- RU/EN screenshot links and reviewed widths;
- assumptions and remaining risks;
- `## User Release Notes` with only user-visible archive/recreate behavior.

Do not mark ready, merge, deploy, access production, or run persistent database writes.
