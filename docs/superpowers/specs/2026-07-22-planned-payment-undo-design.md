# Planned payment undo — design

## Purpose

Allow a user to undo one mistakenly recorded payment of an active planned expense
in the current month. The action makes only that occurrence unpaid and removes
only its linked same-user expense. It is not a general expense undo facility.

## Domain invariants

- A paid occurrence is the exact `planned_expense_payments` row together with
  its linked same-user expense; the current recurrence schedule is not evidence
  for a historical payment.
- The selected occurrence date is a strictly valid `YYYY-MM-DD` key.
- Adjacent weekly, twice-monthly, monthly, and one-off payments remain intact.
- The payment link and expense are changed atomically, or neither is changed.
- A closed reserve month, determined from `expenses.spent_at`, blocks the undo.
- The existing current-local-day opening snapshot and `dayPlanLimit` are never
  invalidated, replaced, or recalculated by undo.
- The repository endpoint may undo an archived plan's existing payment; the
  Mini App exposes controls only for active current-month plans.

## API

`DELETE /api/planned-expenses/:id/payments/:occurrenceDate`

The request body is authenticated through
`apiSecurity.resolveTelegramUserId(req, url, body)`. A client-declared Telegram
ID is never trusted without that existing check.

Responses:

| Condition | HTTP | Body |
| --- | --- | --- |
| matching link and expense removed | 200 | `{ status: "undone", occurrenceDate }` |
| owned plan, link absent | 200 | `{ status: "already_unpaid", occurrenceDate }` |
| invalid calendar key | 400 | `invalid_occurrence` |
| missing or foreign plan | 404 | `planned_expense_not_found` |
| missing or foreign linked expense | 409 | `planned_payment_inconsistent` |
| closed expense month | 409 | `planned_payment_undo_blocked` |

## Repository lifecycle

`undoPlannedExpensePaymentForTelegramUser(plannedExpenseId, telegramUserId,
occurrenceDate, now)` uses one PostgreSQL client and one transaction:

1. Validate the date with `normalizePlannedDateKey`; reject before mutation.
2. Lock the owned plan (`FOR UPDATE`) without an `active` filter.
3. Lock the payment row selected by plan ID plus occurrence date, then its
   linked expense. Absence is the idempotent `already_unpaid` result.
4. Verify that the expense is the linked same-user expense, lock the expense
   month with the existing reserve helpers, and reject a closed month.
5. Explicitly delete the precise payment row and then the same-user expense.
6. Commit. Only after commit, best-effort record
   `planned_expense_payment_undone` with `{ source: "miniapp" }`.

No migration, soft-delete, plan mutation, payment-history purge, history-row
action, or snapshot invalidation is introduced.

## Mini App

`buildPlannedOccurrences(item)` supplies paid occurrence dates. Under each
active current-month plan, render a compact undo button for each `paid: true`
occurrence only. Its label/confirmation identify the exact local occurrence
date.

`plannedPaymentUndo.js` owns one-button lifecycle: confirm, reject a duplicate
click, disable only the chosen button, call the DELETE API, refresh dashboard
and history on `undone` or `already_unpaid`, and restore the button on failure.
The response codes map to localized safe messages; internal IDs, SQL, and stack
details never reach the user.

## Verification

Repository tests cover exact deletion, ownership, malformed dates, idempotency,
closed months, inconsistent links, archived plans, transaction order, analytics,
and snapshot stability. API/security tests assert the exact DELETE path and
status mapping. Mini App tests cover exact-date rendering and helper lifecycle.
The disposable PostgreSQL smoke checks two weekly payments, one exact undo,
idempotent retry, closed-month rollback, and preserved current-day snapshot.
