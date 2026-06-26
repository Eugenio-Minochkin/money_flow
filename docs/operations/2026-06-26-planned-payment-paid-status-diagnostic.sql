-- Diagnostic for planned payments whose linked expense local date differs from occurrence_date.
-- Read-only and safe to run at any time. It does NOT mutate data.
--
-- Why this exists: planned payment paid status is derived from planned_expense_payments,
-- NOT from expenses.spent_at (see ADR 0001 and docs/DOMAIN_RULES.md). These rows therefore
-- render correctly as PAID regardless of the mismatch below. This query only surfaces legacy
-- placement drift so it can be reviewed separately for history/statistics accuracy.

SELECT
  pep.id AS payment_id,
  pep.planned_expense_id,
  pe.description AS planned_description,
  pep.expense_id,
  pep.occurrence_date,
  pep.paid_key,
  e.spent_at,
  (e.spent_at AT TIME ZONE COALESCE(NULLIF(u.timezone, ''), 'Asia/Bangkok'))::date AS expense_local_date,
  u.timezone
FROM planned_expense_payments pep
JOIN planned_expenses pe ON pe.id = pep.planned_expense_id
JOIN users u ON u.id = pe.user_id
JOIN expenses e ON e.id = pep.expense_id
WHERE pep.occurrence_date IS NOT NULL
  AND (e.spent_at AT TIME ZONE COALESCE(NULLIF(u.timezone, ''), 'Asia/Bangkok'))::date <> pep.occurrence_date
ORDER BY pep.id DESC;
