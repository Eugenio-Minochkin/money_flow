ALTER TABLE planned_expenses
ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS planned_expenses_user_active_disabled_idx
ON planned_expenses(user_id, active, disabled_at DESC);
