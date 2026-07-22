# Planned Expense Snapshot Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the current local day's saved `dayPlanLimit` fixed across planned-expense mutations while making disable transactional, preserving paid history, and updating live month state immediately.

**Architecture:** Preserve the existing repository-centered budget model. Planned create/update stop invalidating daily snapshots; disable becomes a repository transaction that returns an impact object; dashboard combines active remaining occurrences with factual paid expenses into a server-owned summary; the Mini App renders that response through a small testable presentation helper.

**Tech Stack:** Node.js ESM, PostgreSQL 17-compatible SQL migrations, Node built-in test runner, browser JavaScript Mini App.

---

### Task 1: Lock The Daily Snapshot Policy With Red Tests

**Files:**
- Modify: `apps/api/test/budgetReserveIntegration.test.js`
- Modify: `apps/api/test/repository.test.js`
- Modify: `apps/api/src/repository.js`

- [ ] **Step 1: Rewrite the opposite-expectation integration test**

Replace the existing planned-mutation invalidation assertion with the approved contract:

```js
test("planned expense changes preserve today's snapshot while monthly state updates", async () => {
  // storedDayBudget: 999, regularToday: 350, planned amount 2000 -> 4000
  assert.equal(state.daySnapshotDeleted, false);
  assert.equal(dashboard.snapshot.dayPlanLimit, 999);
  assert.equal(dashboard.snapshot.dayRemaining, 649);
  assert.equal(dashboard.snapshot.plannedRemaining, 4000);
  assert.notEqual(dashboard.snapshot.safeToSpendPerDay, 999);
});
```

Add create and disable cases, a missing-snapshot case, and a next-local-day case using the existing in-memory budget/reserve state helper.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm.cmd test -- apps/api/test/budgetReserveIntegration.test.js
```

Expected: planned create/update/disable cases fail because repository methods still delete the current `daily_budget_snapshot`.

- [ ] **Step 3: Add repository contract tests for PATCH and invalidation boundaries**

Assert that planned create/update/disable SQL never issues `DELETE FROM daily_budget_snapshots`, that create always writes `active = true`, and update SQL contains no `active =` assignment even if payload contains `active: true`.

- [ ] **Step 4: Implement the minimal snapshot and PATCH fix**

In `createPlannedExpense` and `updatePlannedExpense`, remove only the planned-flow calls to `invalidateDailyBudgetSnapshot`. Remove `active` from `normalizePlannedExpense` and the update SQL/parameters. Leave `invalidateDailyBudgetSnapshot` itself and every budget, top-up, reserve, timezone/currency, and expense-correction caller unchanged.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
npm.cmd test -- apps/api/test/budgetReserveIntegration.test.js apps/api/test/repository.test.js
```

Expected: all selected tests pass, including unchanged budget and reserve invalidation tests.

- [ ] **Step 6: Commit the snapshot policy**

```powershell
git add apps/api/src/repository.js apps/api/test/budgetReserveIntegration.test.js apps/api/test/repository.test.js
git commit -m "fix: preserve daily snapshot for planned changes"
```

### Task 2: Add Disabled Timestamp And Transactional Disable

**Files:**
- Create: `apps/api/migrations/011_planned_expense_disabled_at.sql`
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/test/repository.test.js`
- Modify: `apps/api/integration/postgres-smoke.js`

- [ ] **Step 1: Write failing repository transaction tests**

Test an owned weekly plan locked with `FOR UPDATE`, two valid paid occurrence rows with actual linked `amount_base`, three unpaid current-month occurrences, an active-to-inactive update, preservation of payment/expense rows, and this result:

```js
{
  plannedExpense: { id: "5", active: false },
  impact: {
    paidOccurrencesKept: 2,
    paidAmountKept: 2000,
    unpaidOccurrencesRemoved: 3,
    unpaidAmountRemoved: 3000,
    currency: "THB"
  }
}
```

Add RED cases for repeated disable returning the same impact without another update/event and foreign/missing ownership returning `null`.

- [ ] **Step 2: Run repository tests and verify RED**

```powershell
npm.cmd test -- apps/api/test/repository.test.js
```

Expected: failures show the current direct UPDATE has no transaction, lock, impact calculation, timestamp, or idempotency distinction.

- [ ] **Step 3: Add the additive migration**

Create `011_planned_expense_disabled_at.sql` with:

```sql
ALTER TABLE planned_expenses
ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS planned_expenses_user_active_disabled_idx
ON planned_expenses(user_id, active, disabled_at DESC);
```

Do not backfill legacy inactive rows.

- [ ] **Step 4: Implement transactional disable**

Use `pool.connect()`, `BEGIN`, an owned plan/user query with `FOR UPDATE`, `timeZoneMonthKey(now, userTimezone(plan))`, a payment query joined to `expenses` on matching owner, and the existing occurrence helpers. Update only when `active = true`:

```sql
UPDATE planned_expenses
SET active = false, disabled_at = $2
WHERE id = $1 AND active = true
RETURNING *
```

Record `planned_expense_deleted` only after the transaction reports a real transition. Never delete from `expenses`, `planned_expense_payments`, or `daily_budget_snapshots`.

- [ ] **Step 5: Extend the disposable Postgres smoke**

Update the migration ledger expectation through `011`. Expand create/list/pay/disable to assert `disabled_at`, same-day snapshot stability, live monthly summary, preserved expense/payment rows, idempotent repeat disable, and a next-local-day snapshot derived from the disabled plan set.

- [ ] **Step 6: Run focused repository tests and verify GREEN**

```powershell
npm.cmd test -- apps/api/test/repository.test.js
```

- [ ] **Step 7: Commit transactional lifecycle changes**

```powershell
git add apps/api/migrations/011_planned_expense_disabled_at.sql apps/api/src/repository.js apps/api/test/repository.test.js apps/api/integration/postgres-smoke.js
git commit -m "feat: make planned disable transactional"
```

### Task 3: Add The Server-Owned Planned Month Summary

**Files:**
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/test/repository.test.js`
- Modify: `apps/api/test/budgetReserveIntegration.test.js`
- Modify: `apps/api/test/reportService.test.js`

- [ ] **Step 1: Write failing summary tests**

Cover a partially paid disabled weekly plan and an unpaid active plan. Assert:

```js
assert.deepEqual(dashboard.plannedMonthSummary, {
  paid: 2000,
  remaining: 3000,
  total: 5000,
  display: { currency: "USD", paid: 61.26, remaining: 91.88, total: 153.14 }
});
```

Also assert live `plannedRemaining`, `freeRemaining`, and forecast update while the saved day limit stays fixed. Add reserve-closure and report regressions proving inactive paid occurrences remain included and inactive unpaid occurrences remain excluded.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm.cmd test -- apps/api/test/repository.test.js apps/api/test/budgetReserveIntegration.test.js apps/api/test/reportService.test.js
```

- [ ] **Step 3: Implement one factual paid aggregate plus active remaining**

Reuse the existing valid payment ownership join and user-local month bounds. Build:

```js
const plannedMonthSummary = {
  paid: roundMoney(paidPlannedMonthTotal),
  remaining: roundMoney(plannedRemaining),
  total: roundMoney(paidPlannedMonthTotal + plannedRemaining),
  display: {
    currency: user.display_currency ?? "USD",
    paid: paidPlannedMonthDisplayTotal,
    remaining: plannedRemainingDisplayTotal,
    total: roundMoney(paidPlannedMonthDisplayTotal + plannedRemainingDisplayTotal)
  }
};
```

Return it additively beside existing `snapshot` and active-only `plannedExpenses`.

- [ ] **Step 4: Keep reserve and report semantics unchanged**

If tests expose a validity gap, narrow `plannedObligationsForPeriod` to count paid rows only when their linked expense exists and belongs to the same user, without changing recurrence or reserve formulas.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the same command from Step 2 and confirm all selected tests pass.

- [ ] **Step 6: Commit server summary changes**

```powershell
git add apps/api/src/repository.js apps/api/test/repository.test.js apps/api/test/budgetReserveIntegration.test.js apps/api/test/reportService.test.js
git commit -m "feat: add planned month summary"
```

### Task 4: Return Disable Impact Through The API

**Files:**
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/test/security.test.js`

- [ ] **Step 1: Add a failing route-contract test**

Use the repository result contract and a source-level route assertion to prove DELETE responds with both `plannedExpense` and `impact`, PATCH still responds with only its updated `plannedExpense`, and not-found remains HTTP 404.

- [ ] **Step 2: Run the focused server contract test and verify RED**

```powershell
npm.cmd test -- apps/api/test/security.test.js
```

- [ ] **Step 3: Implement the additive DELETE response**

Keep PATCH and DELETE branches explicit:

```js
if (req.method === "PATCH") {
  const plannedExpense = await repository.updatePlannedExpense(...);
  return sendJson(res, 200, { plannedExpense });
}
const result = await repository.deactivatePlannedExpense(...);
if (!result) return sendJson(res, 404, { error: "planned_expense_not_found" });
return sendJson(res, 200, result);
```

- [ ] **Step 4: Run the focused test and verify GREEN**

```powershell
npm.cmd test -- apps/api/test/security.test.js
```

- [ ] **Step 5: Commit the API contract**

```powershell
git add apps/api/src/server.js apps/api/test/security.test.js
git commit -m "feat: return planned disable impact"
```

### Task 5: Implement Testable Mini App Confirmation And Result UX

**Files:**
- Create: `apps/miniapp/src/plannedDisable.js`
- Create: `apps/miniapp/test/plannedDisable.test.js`
- Modify: `apps/miniapp/src/app.js`
- Modify: `apps/miniapp/src/i18n.js`
- Modify: `apps/miniapp/test/i18n.test.js`
- Modify: `apps/miniapp/test/smokeAssets.test.js`
- Modify: `apps/miniapp/test/planned.test.js`

- [ ] **Step 1: Write failing pure interaction tests**

Test exact RU/EN confirmation and result text, button pending state, a second invocation returning before DELETE, one API call, and event ordering:

```js
assert.deepEqual(events, ["confirm", "disable", "loadDashboard", "showResult"]);
```

Test result amounts come from backend `impact`, not the active-only client plan list.

- [ ] **Step 2: Run Mini App tests and verify RED**

```powershell
npm.cmd test -- apps/miniapp/test/plannedDisable.test.js apps/miniapp/test/planned.test.js apps/miniapp/test/i18n.test.js apps/miniapp/test/smokeAssets.test.js
```

- [ ] **Step 3: Implement the focused interaction helper**

Create a small dependency-injected helper that:

```js
if (button.disabled) return { status: "busy" };
if (!confirm(buildConfirmation(item, language))) return { status: "cancelled" };
button.disabled = true;
try {
  const result = await disableRequest(item.id);
  await loadDashboard();
  showResult(buildResult(item, result.impact, language, formatMoney));
  return { status: "disabled", result };
} finally {
  if (button.isConnected) button.disabled = false;
}
```

Use exact approved Russian and English meaning, including that paid history remains, unpaid occurrences stop counting, the monthly plan is updated, and today's budget is unchanged.

- [ ] **Step 4: Wire the helper and server summary into `app.js`**

Resolve the item from the current active list, call the helper from the disable button, and use `dashboardState.plannedMonthSummary` in `renderPlannedMonthSummary`, retaining the client calculation only as a compatibility fallback for old dashboard responses.

- [ ] **Step 5: Run Mini App focused tests and verify GREEN**

Run the command from Step 2 and confirm all selected tests pass.

- [ ] **Step 6: Perform compact mobile visual verification**

Run the local Mini App sandbox and capture RU/EN screenshots at iPhone 11 and iPhone 14 Pro widths. Confirm no permanent archive or large dashboard block was added.

- [ ] **Step 7: Commit Mini App UX**

```powershell
git add apps/miniapp/src/plannedDisable.js apps/miniapp/src/app.js apps/miniapp/src/i18n.js apps/miniapp/test/plannedDisable.test.js apps/miniapp/test/planned.test.js apps/miniapp/test/i18n.test.js apps/miniapp/test/smokeAssets.test.js
git commit -m "feat: explain planned expense disable impact"
```

### Task 6: Update Domain Documentation And Verify The Whole Change

**Files:**
- Modify: `docs/DOMAIN_RULES.md`
- Modify: `docs/DECISIONS.md`
- Modify: `docs/TESTING_GUIDE.md`

- [ ] **Step 1: Record the stable domain rules**

Document verbatim in meaning:

```text
Planned-payment mutations immediately update live monthly obligations and forecast but do not replace an already-created current-local-day opening snapshot. The next local day receives a new snapshot from the then-current active plan set.

Disabling a plan cancels only its unpaid obligations. Valid paid occurrences and linked expenses remain historical facts.
```

Also document the server-owned paid/remaining summary and the new Postgres smoke coverage.

- [ ] **Step 2: Run focused verification**

```powershell
npm.cmd test -- apps/api/test/budgetReserveIntegration.test.js apps/api/test/repository.test.js apps/api/test/reportService.test.js apps/api/test/security.test.js apps/miniapp/test/plannedDisable.test.js apps/miniapp/test/planned.test.js apps/miniapp/test/i18n.test.js apps/miniapp/test/smokeAssets.test.js
```

- [ ] **Step 3: Run the full unit suite**

```powershell
npm.cmd test
```

- [ ] **Step 4: Run disposable Postgres integration**

```powershell
npm.cmd run test:integration:postgres
```

Expected: the safety guard confirms a localhost test database, migrations 001-011 apply idempotently, and the expanded planned lifecycle smoke passes.

- [ ] **Step 5: Review the final diff**

```powershell
git diff --check
git diff origin/master...HEAD --stat
git status --short
```

Confirm there are no production values, unrelated refactors, old-migration edits, archive UI, restoration, Undo payment, or general mutation-policy changes.

- [ ] **Step 6: Commit documentation**

```powershell
git add docs/DOMAIN_RULES.md docs/DECISIONS.md docs/TESTING_GUIDE.md docs/superpowers/plans/2026-07-22-planned-expense-snapshot-lifecycle.md
git commit -m "docs: record planned snapshot lifecycle"
```

- [ ] **Step 7: Push and open a draft PR**

Push `codex/planned-expense-snapshot-lifecycle` and open a draft PR into `master`. Include root cause, changed domain rules, English 2/5 and unpaid-rent before/after examples, same-day and next-day snapshot evidence, RU/EN screenshots, unit/Postgres results, additive DB impact, forward-fix plan, assumptions, and `## User Release Notes`. Do not merge or deploy.
