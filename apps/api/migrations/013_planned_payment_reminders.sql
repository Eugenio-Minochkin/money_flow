CREATE TABLE IF NOT EXISTS planned_payment_reminders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  planned_expense_id BIGINT NOT NULL REFERENCES planned_expenses(id) ON DELETE CASCADE,
  occurrence_date DATE NOT NULL,
  next_reminder_local_date DATE,
  last_sent_local_date DATE,
  sent_count INTEGER NOT NULL DEFAULT 0,
  timezone_used TEXT NOT NULL,
  tg_chat_id BIGINT,
  tg_message_id BIGINT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paid', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (planned_expense_id, occurrence_date)
);

CREATE INDEX IF NOT EXISTS planned_payment_reminders_user_date_idx
ON planned_payment_reminders(user_id, occurrence_date);
