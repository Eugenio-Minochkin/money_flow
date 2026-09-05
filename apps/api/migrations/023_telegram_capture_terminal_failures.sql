ALTER TABLE telegram_expense_captures
  DROP CONSTRAINT IF EXISTS telegram_expense_captures_status_check;

ALTER TABLE telegram_expense_captures
  ADD CONSTRAINT telegram_expense_captures_status_check
  CHECK (status IN ('processing', 'completed', 'failed'));
