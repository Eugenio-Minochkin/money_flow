CREATE TABLE IF NOT EXISTS report_deliveries (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL CHECK (report_type IN ('weekly', 'monthly')),
  period_key TEXT NOT NULL,
  period_start_utc TIMESTAMPTZ NOT NULL,
  period_end_utc TIMESTAMPTZ NOT NULL,
  timezone_used TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  telegram_message_id BIGINT,
  generated_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  skip_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, report_type, period_key)
);

CREATE INDEX IF NOT EXISTS report_deliveries_user_period_idx
  ON report_deliveries(user_id, report_type, period_key);

CREATE INDEX IF NOT EXISTS report_deliveries_status_created_idx
  ON report_deliveries(status, created_at);
