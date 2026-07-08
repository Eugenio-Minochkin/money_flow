CREATE TABLE IF NOT EXISTS feedback (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  telegram_user_id BIGINT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'archived')),
  source TEXT NOT NULL DEFAULT 'bot' CHECK (source IN ('bot', 'miniapp')),
  CHECK (length(btrim(message)) >= 3)
);

CREATE INDEX IF NOT EXISTS feedback_status_created_at_idx ON feedback(status, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_telegram_user_created_at_idx ON feedback(telegram_user_id, created_at DESC);
