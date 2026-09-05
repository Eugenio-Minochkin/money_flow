ALTER TABLE telegram_expense_captures
  ADD COLUMN IF NOT EXISTS payload JSONB,
  ADD COLUMN IF NOT EXISTS last_error_code TEXT,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS telegram_expense_captures_runnable_idx
  ON telegram_expense_captures (created_at, user_id)
  WHERE status = 'processing';
