# Planned Payment Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make valid planned-payment links authoritative even when historical expense dates differ from occurrence dates, without allowing duplicate charges.

**Architecture:** Keep `planned_expense_payments` as the occurrence identity and `expenses` as the ownership/existence proof. Remove date equality from the two validity joins while preserving transactions, unique keys, explicit occurrence validation, and the current Mini App contract.

**Tech Stack:** Node.js ESM, PostgreSQL 16, `node:test`, Telegram Mini App JavaScript.

---

### Task 1: Planned-listing regression

**Files:**
- Modify: `apps/api/test/repository.test.js`
- Modify: `apps/api/src/repository.js`

- [ ] **Step 1: Write the failing listing test**

Extend the planned-listing tests with a case whose fake SQL handler returns a payment backed by a same-user expense while asserting that the generated join does not contain:

```sql
(e.spent_at + interval '7 hours')::date = pep.occurrence_date
```

The returned row must expose:

```js
paid_occurrence_dates: ["2026-06-14"],
paid_occurrences: {
  "2026-06-14": { expense_id: "187", paid_at: "2026-06-15T06:53:14.825Z" }
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test --test-name-pattern="date-mismatched same-user expense" apps/api/test/repository.test.js
```

Expected: FAIL because the query still requires expense local date equality.

- [ ] **Step 3: Remove date equality from the listing join**

Change the valid-payment join to:

```sql
JOIN expenses e ON e.id = pep.expense_id
                AND e.user_id = pe.user_id
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2. Expected: PASS.

### Task 2: Duplicate-payment regression

**Files:**
- Modify: `apps/api/test/repository.test.js`
- Modify: `apps/api/src/repository.js`

- [ ] **Step 1: Write the failing duplicate-payment test**

Use `fakePayClient` with a monthly payment row:

```js
{
  occurrence_date: "2026-06-14",
  paid_key: "2026-06"
}
```

Assert that paying occurrence `2026-06-14` rejects with `already_paid`, that no `INSERT INTO expenses` is issued, and that the existing-payment query does not require `spent_at` equality.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test --test-name-pattern="date-mismatched linked expense blocks duplicate" apps/api/test/repository.test.js
```

Expected: FAIL because the existing-payment query still filters the row by local expense date.

- [ ] **Step 3: Remove date equality from the payment lookup**

Change the join to:

```sql
JOIN expenses e ON e.id = pep.expense_id
                AND e.user_id = $3
```

Do not alter transaction boundaries, `FOR UPDATE`, `resolveOccurrenceDate`, `plannedPaymentKey`, `ON CONFLICT`, or `23505` handling.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2. Expected: PASS.

### Task 3: Broken-link behavior and full verification

**Files:**
- Modify: `apps/api/test/repository.test.js`
- Create: `docs/operations/2026-06-18-planned-payment-repair.sql`

- [ ] **Step 1: Add focused broken-link assertions**

Cover these query-contract cases:

```text
missing linked expense -> omitted from paid rows
linked expense owned by another user -> omitted from paid rows
same-user linked expense -> included regardless of spent_at date
```

Verify a legitimate unpaid occurrence can still proceed when no valid paid row is returned.

- [ ] **Step 2: Run repository tests**

Run:

```powershell
node --test apps/api/test/repository.test.js
```

Expected: all repository tests pass.

- [ ] **Step 3: Add non-executing repair SQL**

Create a transaction script with:

```sql
BEGIN;

-- Preview exact target payment and expense rows.
SELECT ... WHERE pep.id IN (10, 11, 13, 14);

-- Optional repair; intentionally left commented.
-- UPDATE expenses ...

ROLLBACK;
```

The UPDATE must derive Bangkok local noon from `occurrence_date`, constrain both payment ID and expense ID, and remain commented so running the file cannot mutate production.

- [ ] **Step 4: Run the full suite**

Run:

```powershell
npm.cmd test
```

Expected: 0 failures.

- [ ] **Step 5: Review the diff**

Run:

```powershell
git diff --check
git diff -- apps/api/src/repository.js apps/api/test/repository.test.js docs/operations/2026-06-18-planned-payment-repair.sql
```

Confirm only the two validity joins, focused regressions, and safe repair documentation changed.
