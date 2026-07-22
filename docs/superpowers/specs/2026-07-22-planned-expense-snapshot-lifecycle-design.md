# Planned Expense Snapshot Lifecycle Design

## Problem

Creating, editing, or disabling a planned expense currently invalidates the current local day's `daily_budget_snapshot`. The next dashboard request then recalculates `dayPlanLimit` from the changed plan set, even when that day's opening snapshot already existed. This mixes two different kinds of state:

- live monthly obligations and forecast, which must reflect a plan mutation immediately;
- the current local day's saved opening limit, which must stay fixed once created.

The planned-expense lifecycle also has three related consistency gaps. A normal PATCH can change `active`, disabling is not transactional or idempotent, and the Mini App derives its month summary only from the active plan list. Consequently, disabling a partially paid plan can hide valid paid history from the plan summary even though its expenses and payment links still exist.

## Product Rules

1. Planned-expense creation, editing, and disabling immediately update live monthly values, including remaining obligations, weekly obligations, reserved-ahead totals, free remaining, forecast, recovery advice, the month paid/remaining summary, and the next active planned payment.
2. A current-local-day daily snapshot that already exists is not deleted or replaced by those mutations. Its `dayPlanLimit` and `display.dayPlanLimit` remain fixed.
3. Today's ordinary spending continues to update `today`, `dayRemaining`, and `dayOverrun` against that fixed limit.
4. `safeToSpendPerDay` remains a live month-end pace metric and may change immediately. It must not be presented as today's saved limit.
5. If no snapshot exists when the plan changes, the first later dashboard request creates one from the then-current state. The system does not reconstruct an unrecorded morning state.
6. The first dashboard request on the next local day creates a new snapshot from the active plan set at that time.
7. Disabling a plan cancels only unpaid occurrences. Valid paid occurrences, linked `expenses`, and `planned_expense_payments` remain historical facts.
8. Paid status continues to come from a valid payment row whose linked expense exists and belongs to the same user.

Budget changes, current-month overrides, budget top-ups, reserve changes, timezone/currency changes, and expense corrections that alter the opening baseline keep their existing snapshot policies.

## Planned Expense Lifecycle

Creation always persists `active = true`. Normal update accepts only amount, currency, description, category, tags, and recurrence fields; an `active` value in the payload is ignored and cannot reactivate a disabled plan. Disable remains the only endpoint that can transition `active` from true to false. Reactivation is not part of this change.

Disabling runs in one database transaction:

1. resolve the user;
2. lock the owned planned expense with `FOR UPDATE`;
3. determine the current local month through `users.timezone`;
4. identify valid paid occurrences through their owned linked expenses;
5. calculate the kept paid impact and removed unpaid impact;
6. transition an active plan to `active = false` and set `disabled_at`;
7. commit without deleting expenses or payment links;
8. record `planned_expense_deleted` only for the real active-to-inactive transition.

A repeated disable returns the same stable impact without another state transition or analytics event. A missing or foreign plan returns the existing not-found contract.

The disable response is additive:

```json
{
  "plannedExpense": {},
  "impact": {
    "paidOccurrencesKept": 2,
    "paidAmountKept": 2000,
    "unpaidOccurrencesRemoved": 3,
    "unpaidAmountRemoved": 3000,
    "currency": "THB"
  }
}
```

`paidAmountKept` is the sum of actual linked `expenses.amount_base`, not occurrence count multiplied by the plan's current amount. `unpaidAmountRemoved` uses the plan's current base amount and the concrete unpaid occurrences in the user's current local month.

## Dashboard Month Summary

The dashboard gains an additive `plannedMonthSummary` field:

```json
{
  "paid": 2000,
  "remaining": 3000,
  "total": 5000,
  "display": {
    "currency": "USD",
    "paid": 61.26,
    "remaining": 91.88,
    "total": 153.14
  }
}
```

`paid` sums actual paid planned expenses in the current user-local month, including payments belonging to disabled plans. `remaining` includes only unpaid occurrences of active plans. `total` is `paid + remaining`. Display values use the existing base/display currency conversion behavior.

Existing `snapshot` and `plannedExpenses` fields remain backward compatible. The default planned-expenses endpoint continues to return active plans only. The Mini App uses the server summary for its month header instead of deriving financial truth exclusively from that active list.

## Mini App Interaction

Disabling requires an explicit confirmation naming the plan and explaining that paid entries stay in history while unpaid entries stop counting toward the month plan. The disable button is locked while the request is pending so a double tap sends one DELETE.

After a successful response, the Mini App waits for `loadDashboard()`, rerenders live monthly state, and only then shows a localized result based on the server impact. The result states the kept payment count and amount, removed upcoming count and amount, that the month plan was updated, and that today's budget stayed unchanged. It must not promise a scheduled morning update.

The UI remains compact and is checked at iPhone 11 and iPhone 14 Pro widths. This change does not add an archive block to the dashboard.

## Persistence

A new additive migration adds:

```sql
ALTER TABLE planned_expenses
ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS planned_expenses_user_active_disabled_idx
ON planned_expenses(user_id, active, disabled_at DESC);
```

Legacy inactive rows remain with `disabled_at = NULL`; there is no backfill. Rollback is forward-fix because the migration neither rewrites nor deletes existing data.

## Error And Consistency Boundaries

- Reserve-capacity validation keeps its existing behavior for create and update.
- Disable does not change reserve formulas. Reserve closure counts all occurrences for active plans and only valid paid occurrences for disabled plans.
- Closed-month behavior and report formulas do not change. Regression coverage proves that paid planned expenses from disabled plans remain factual report expenses.
- The existing privacy-safe `planned_expense_deleted` metadata remains unchanged and excludes names, amounts, currencies, and dates.
- No production data fix, production SQL, scheduler, archive UI, restoration, or undo-payment flow is introduced.

## Verification Design

Tests are written red-first and cover:

- create, update, and disable preserving an existing current-day snapshot;
- current-day creation from current data when no snapshot existed;
- a new next-local-day snapshot reflecting the changed plan set;
- fixed `dayPlanLimit = 999`, regular spending of `350`, and live `dayRemaining = 649` while monthly values update;
- partially paid weekly plan disable preserving two payments and removing three unpaid occurrences;
- an entirely unpaid plan leaving no factual spending while immediately freeing its remaining obligation;
- transactional ownership, idempotent repeated disable, one analytics event, and PATCH immunity from `active`;
- server DELETE impact and additive dashboard compatibility;
- server month summary retaining disabled-plan paid totals;
- reserve closure and report paid-history regressions;
- Asia/Bangkok and America/New_York or Europe/Paris local boundaries;
- Mini App confirmation, pending lock, double-tap protection, dashboard-before-result ordering, exact RU/EN output, and server-summary rendering;
- real migration ledger and create/list/pay/disable/dashboard behavior in the disposable Postgres smoke suite.

Focused tests run first, followed by `npm.cmd test` and `npm.cmd run test:integration:postgres`.

## Scope Boundaries

This design does not add a full inactive-plan archive, restore disabled plans, add Undo payment, add `starts_on` or `effective_from`, introduce a general mutation-policy layer, change recurrence formulas, change reserve or budget/top-up behavior, change ordinary expense behavior, rewrite old migrations, or modify production data.
