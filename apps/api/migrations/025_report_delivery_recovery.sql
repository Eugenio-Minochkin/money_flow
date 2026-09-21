ALTER TABLE report_deliveries
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 0);
