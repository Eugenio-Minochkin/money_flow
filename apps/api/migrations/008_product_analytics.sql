ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_source TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_first_seen_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_blocked_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_unblocked_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS app_events_singleton_onboarding_user_event_idx
ON app_events (user_id, event_name)
WHERE user_id IS NOT NULL
  AND event_name IN (
    'onboarding_started',
    'currency_selected',
    'budget_set',
    'onboarding_completed'
  );
