# Weekly Budget UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add day/week/month progress controls, a configurable weekly budget, and warm-clean visual polish without removing existing dashboard sections.

**Architecture:** Keep calculations in `packages/shared/src/budget.js` so API, Telegram, and Mini App share one snapshot contract. Store optional weekly budget on `users.weekly_budget_amount`; if absent, derive weekly plan from monthly budget. Keep Mini App vanilla JS/CSS and update only existing dashboard/settings surfaces.

**Tech Stack:** Node.js ESM, `node:test`, Postgres migrations, vanilla HTML/CSS/JS.

---

### Task 1: Budget Snapshot Calculations

**Files:**
- Modify: `packages/shared/src/budget.js`
- Test: `packages/shared/test/budget.test.js`

- [ ] **Step 1: Write failing tests**

Add tests for:

```js
test("calculates day week and month progress controls", () => {
  const snapshot = calculateBudgetSnapshot({
    todayTotal: 650,
    weekTotal: 3350,
    monthTotal: 18800,
    monthlyBudget: 45000,
    weeklyBudget: 11250,
    plannedThisWeekTotal: 1000,
    now: new Date("2026-06-10T10:00:00+07:00")
  });

  assert.equal(snapshot.dayPlanLimit, 1980);
  assert.equal(snapshot.dayRemaining, 1330);
  assert.equal(snapshot.dayProgressPercent, 32.83);
  assert.equal(snapshot.weekPlanLimit, 11250);
  assert.equal(snapshot.weekRemaining, 6900);
  assert.equal(snapshot.weekProgressPercent, 29.78);
  assert.equal(snapshot.monthRemaining, 26200);
  assert.equal(snapshot.progress.day.state, "good");
});
```

- [ ] **Step 2: Run test and confirm it fails**

Run: `npm.cmd test packages/shared/test/budget.test.js`

- [ ] **Step 3: Implement snapshot fields**

Add day/week/month plan, remaining, percent, display fields, and progress states.

- [ ] **Step 4: Run shared tests**

Run: `npm.cmd test packages/shared/test/budget.test.js`

### Task 2: Weekly Budget Setting

**Files:**
- Modify: `apps/api/migrations/001_initial.sql`
- Modify: `apps/api/src/repository.js`
- Test: `apps/api/test/repository.test.js`

- [ ] **Step 1: Write failing settings test**

Update settings test to pass `weeklyBudgetAmount: 12000` and assert SQL params and returned row include `weekly_budget_amount`.

- [ ] **Step 2: Run test and confirm it fails**

Run: `npm.cmd test apps/api/test/repository.test.js`

- [ ] **Step 3: Implement storage and update**

Add `users.weekly_budget_amount NUMERIC(14, 2)`, include it in settings update, and pass it to budget snapshot.

- [ ] **Step 4: Run API tests**

Run: `npm.cmd test apps/api/test/repository.test.js`

### Task 3: Planned Expenses In Current Week

**Files:**
- Modify: `apps/api/src/repository.js`
- Test: `apps/api/test/repository.test.js`

- [ ] **Step 1: Write failing dashboard test**

Add a dashboard test with an unpaid planned expense due in the current week and assert `snapshot.plannedThisWeek` and `snapshot.weekRemaining` subtract it.

- [ ] **Step 2: Run test and confirm it fails**

Run: `npm.cmd test apps/api/test/repository.test.js`

- [ ] **Step 3: Implement current-week planned reserve**

Calculate unpaid planned occurrences whose due date falls inside current local week, then pass the total to `calculateBudgetSnapshot`.

- [ ] **Step 4: Run API tests**

Run: `npm.cmd test apps/api/test/repository.test.js`

### Task 4: Mini App UI

**Files:**
- Modify: `apps/miniapp/src/index.html`
- Modify: `apps/miniapp/src/app.js`
- Modify: `apps/miniapp/src/styles.css`

- [ ] **Step 1: Update dashboard markup**

Change metric cards to: `Сегодня / Неделя`, `Осталось / Месяц`, with progress bars for Today, Week, Month.

- [ ] **Step 2: Update rendering**

Render new snapshot fields and apply `good`, `warn`, `danger` classes to progress UI.

- [ ] **Step 3: Update settings form**

Add optional weekly budget input and include it in settings PATCH.

- [ ] **Step 4: Polish CSS**

Apply warm-clean variant A: cleaner cards, subtle shadows, richer progress states, stable mobile layout.

### Task 5: Verification

**Files:**
- Verify only

- [ ] **Step 1: Run full test suite**

Run: `npm.cmd test`

- [ ] **Step 2: Start local app**

Run: `npm.cmd run start:api`

- [ ] **Step 3: Open Mini App in browser**

Open `http://localhost:3000/?telegramUserId=...` with an existing local user or verify static rendering/API behavior with the available local data.
