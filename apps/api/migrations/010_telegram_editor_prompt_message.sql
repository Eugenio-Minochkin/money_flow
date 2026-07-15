ALTER TABLE telegram_input_sessions
  ADD COLUMN IF NOT EXISTS prompt_message_id BIGINT;
