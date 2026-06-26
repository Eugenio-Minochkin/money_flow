# Planned payment paid status is derived from the payment registry, not the expense date

A planned occurrence is considered paid when `planned_expense_payments` holds a row for that planned expense and occurrence whose linked expense exists and belongs to the same user. The local date of the linked expense (`expenses.spent_at`) must **not** participate in deciding paid status.

This is a deliberate deviation from the tempting "the expense date should match the occurrence date" check. Payment data (`planned_expense_payments`) is the authoritative record of intent; the expense's `spent_at` is history/statistics placement. Tying paid status to a `spent_at = occurrence_date` equality made otherwise-valid payments vanish from the dashboard's overdue block and from the Plan tab, and allowed duplicate Pay clicks to create second expenses.

It is tempting to re-introduce `(e.spent_at AT TIME ZONE tz)::date = pep.occurrence_date` to "harden" the read and pay-lookup queries. Do not. It was removed in PR #34, accidentally re-added in PR #61 (daily reminders), and restored again on 2026-06-26 after the regression recurred. The existence check (`e.id = pep.expense_id`) and same-user check (`e.user_id = pe.user_id`) stay; the date equality does not.
