-- Optional production repair for planned payments diagnosed on 2026-06-18.
-- This file is safe to run as-is: the UPDATE is commented and the transaction
-- always rolls back. Review the preview before enabling any mutation.

BEGIN;

SELECT
  pep.id AS payment_id,
  pep.planned_expense_id,
  pe.user_id,
  pe.description AS planned_description,
  pep.expense_id,
  pep.occurrence_date,
  e.spent_at AS current_spent_at,
  (e.spent_at + interval '7 hours')::date AS current_local_date,
  (pep.occurrence_date::timestamp + interval '12 hours')
    AT TIME ZONE 'Asia/Bangkok' AS proposed_spent_at
FROM planned_expense_payments pep
JOIN planned_expenses pe ON pe.id = pep.planned_expense_id
JOIN expenses e
  ON e.id = pep.expense_id
 AND e.user_id = pe.user_id
WHERE (pep.id, pep.expense_id) IN (
  (10, 120), -- Продукты: 2026-06-01, currently recorded 2026-06-08
  (11, 152), -- iCloud: 2026-06-11, currently recorded 2026-06-12
  (13, 166), -- Терапия: 2026-06-11, currently recorded 2026-06-13
  (14, 187)  -- Simcard: 2026-06-14, currently recorded 2026-06-15
)
  AND pep.occurrence_date IS DISTINCT FROM (e.spent_at + interval '7 hours')::date
ORDER BY pep.id;

-- Explicit approval is required before uncommenting this repair.
--
-- UPDATE expenses e
-- SET spent_at = (pep.occurrence_date::timestamp + interval '12 hours')
--                  AT TIME ZONE 'Asia/Bangkok'
-- FROM planned_expense_payments pep
-- JOIN planned_expenses pe ON pe.id = pep.planned_expense_id
-- WHERE e.id = pep.expense_id
--   AND e.user_id = pe.user_id
--   AND (pep.id, pep.expense_id) IN (
--     (10, 120),
--     (11, 152),
--     (13, 166),
--     (14, 187)
--   )
--   AND pep.occurrence_date IS DISTINCT FROM (e.spent_at + interval '7 hours')::date;

SELECT
  pep.id AS payment_id,
  pep.expense_id,
  pep.occurrence_date,
  e.spent_at,
  (e.spent_at + interval '7 hours')::date AS expense_local_date
FROM planned_expense_payments pep
JOIN planned_expenses pe ON pe.id = pep.planned_expense_id
JOIN expenses e
  ON e.id = pep.expense_id
 AND e.user_id = pe.user_id
WHERE (pep.id, pep.expense_id) IN (
  (10, 120),
  (11, 152),
  (13, 166),
  (14, 187)
)
ORDER BY pep.id;

ROLLBACK;
