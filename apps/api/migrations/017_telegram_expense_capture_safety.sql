CREATE TABLE IF NOT EXISTS telegram_expense_captures (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  draft_id BIGINT REFERENCES drafts(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed')),
  claim_version BIGINT NOT NULL DEFAULT 0,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE(user_id, chat_id, message_id)
);
