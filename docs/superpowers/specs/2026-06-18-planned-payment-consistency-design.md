# Planned Payment Consistency Design

## Problem

Production contains valid `planned_expense_payments` rows whose linked expense belongs to the same user but has a local `spent_at` date different from `occurrence_date`. The current read query excludes those rows from `paid_occurrences`, so the Mini App renders the occurrence as unpaid. A repeated payment then collides with the existing unique `paid_key` or `occurrence_date` and returns `already_paid`.

Confirmed production examples on June 18, 2026:

- `Продукты`: occurrence June 1, expense local date June 8.
- `Терапия`: occurrence June 11, expense local date June 13.
- `Simcard`: occurrence June 14, expense local date June 15.
- `iCloud`: occurrence June 11, expense local date June 12.

No missing-expense or wrong-user rows were found.

## Consistency Rule

A planned occurrence is paid when:

1. `planned_expense_payments` identifies the planned expense and occurrence;
2. its linked expense exists;
3. the expense belongs to the same user as the planned expense.

`expense.spent_at` is history placement, not payment-link validity. New payments must still create the expense on `occurrence_date`, but old date mismatches must not make an otherwise valid payment appear unpaid.

## Code Changes

- Remove the `spent_at`/`occurrence_date` equality requirement from the valid-payment joins used by:
  - planned-expense listing;
  - existing-payment lookup before payment.
- Keep the existing transaction, planned-row lock, unique `paid_key`, occurrence validation, and rollback behavior.
- Preserve rejection of missing expenses and expenses belonging to another user.
- Do not silently mutate production data.

## Tests

Add regressions proving:

- a same-user linked expense with a mismatched date marks the occurrence paid;
- the same mismatch blocks a duplicate payment before expense insertion;
- missing or wrong-user linked expenses do not block a legitimate payment;
- existing weekly, twice-monthly, monthly, occurrence-date, unique-key, and rollback behavior remains intact.

## Optional Data Repair

Code correctness does not require repair. If historical placement should match the planned occurrence, provide a separate transaction containing:

1. a SELECT listing exact affected rows;
2. an UPDATE limited to those payment IDs that moves `expenses.spent_at` to local noon on `occurrence_date`;
3. a verification SELECT.

Do not execute this repair without explicit approval.
