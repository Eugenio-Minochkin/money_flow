ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS telegram_input_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('draft', 'expense')),
  target_id BIGINT NOT NULL,
  item_index INTEGER,
  field TEXT NOT NULL CHECK (field IN ('amount', 'description', 'spent_at', 'tags')),
  chat_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('ru', 'en')),
  status TEXT NOT NULL CHECK (status IN (
    'active', 'processing', 'completed', 'cancelled', 'expired_unconsumed', 'expired_consumed'
  )),
  expires_at TIMESTAMPTZ NOT NULL,
  late_input_consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (target_type = 'draft' AND item_index IS NOT NULL AND item_index >= 0)
    OR (target_type = 'expense' AND item_index IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS telegram_input_sessions_one_busy_user_idx
  ON telegram_input_sessions(user_id)
  WHERE status IN ('active', 'processing');

CREATE INDEX IF NOT EXISTS telegram_input_sessions_cleanup_idx
  ON telegram_input_sessions(status, expires_at);
