CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL UNIQUE,
  first_name TEXT,
  username TEXT,
  base_currency TEXT NOT NULL DEFAULT 'THB',
  display_currency TEXT NOT NULL DEFAULT 'USD',
  usd_thb_rate NUMERIC(14, 6) NOT NULL DEFAULT 32.65,
  monthly_budget_amount NUMERIC(14, 2) NOT NULL DEFAULT 45000,
  weekly_budget_amount NUMERIC(14, 2),
  interface_language TEXT NOT NULL DEFAULT 'en',
  interface_theme TEXT NOT NULL DEFAULT 'light',
  budget_advice_enabled BOOLEAN NOT NULL DEFAULT true,
  onboarding_step TEXT NOT NULL DEFAULT 'completed',
  onboarding_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS display_currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE users ADD COLUMN IF NOT EXISTS usd_thb_rate NUMERIC(14, 6) NOT NULL DEFAULT 32.65;
ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_budget_amount NUMERIC(14, 2);
ALTER TABLE users ADD COLUMN IF NOT EXISTS interface_language TEXT NOT NULL DEFAULT 'en';
ALTER TABLE users ADD COLUMN IF NOT EXISTS interface_theme TEXT NOT NULL DEFAULT 'light';
ALTER TABLE users ALTER COLUMN interface_theme SET DEFAULT 'light';
UPDATE users SET interface_theme = 'light' WHERE interface_theme IS NULL OR interface_theme NOT IN ('light', 'dark');
ALTER TABLE users ADD COLUMN IF NOT EXISTS budget_advice_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_step TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_blocked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_data JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ALTER COLUMN usd_thb_rate SET DEFAULT 32.65;
UPDATE users SET usd_thb_rate = 32.65 WHERE usd_thb_rate = 36;
UPDATE users SET interface_language = 'ru' WHERE telegram_user_id = 428925787;

CREATE TABLE IF NOT EXISTS drafts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled', 'inbox')),
  source_text TEXT NOT NULL,
  items JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS expenses (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_id BIGINT REFERENCES drafts(id) ON DELETE SET NULL,
  amount_original NUMERIC(14, 2) NOT NULL,
  currency_original TEXT NOT NULL,
  amount_base NUMERIC(14, 2) NOT NULL,
  base_currency TEXT NOT NULL DEFAULT 'THB',
  converted_amounts JSONB NOT NULL DEFAULT '{}'::jsonb,
  exchange_rate_date DATE NOT NULL,
  exchange_rate_source TEXT NOT NULL DEFAULT 'mvp-static-1:1',
  description TEXT NOT NULL,
  category_slug TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  spent_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS budget_impact TEXT NOT NULL DEFAULT 'regular';

CREATE INDEX IF NOT EXISTS expenses_user_spent_at_idx ON expenses(user_id, spent_at DESC);
CREATE INDEX IF NOT EXISTS drafts_user_status_idx ON drafts(user_id, status);

CREATE TABLE IF NOT EXISTS daily_budget_snapshots (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_key TEXT NOT NULL,
  budget_amount_base NUMERIC(14, 2) NOT NULL,
  budget_display_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, day_key)
);

CREATE TABLE IF NOT EXISTS month_baselines (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month_key TEXT NOT NULL,
  amount_base NUMERIC(14, 2) NOT NULL DEFAULT 0,
  source_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, month_key)
);

CREATE TABLE IF NOT EXISTS monthly_budget_overrides (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month_key TEXT NOT NULL,
  budget_amount_base NUMERIC(14, 2) NOT NULL,
  is_partial_month BOOLEAN NOT NULL DEFAULT false,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, month_key)
);

UPDATE expenses
SET amount_base = NULLIF(converted_amounts->>base_currency, '')::numeric
WHERE base_currency <> 'THB'
  AND converted_amounts ? base_currency
  AND NULLIF(converted_amounts->>base_currency, '') IS NOT NULL;

CREATE TABLE IF NOT EXISTS planned_expenses (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(14, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'THB',
  amount_base NUMERIC(14, 2) NOT NULL,
  description TEXT NOT NULL,
  category_slug TEXT NOT NULL DEFAULT 'other',
  tags TEXT[] NOT NULL DEFAULT '{}',
  recurrence TEXT NOT NULL CHECK (recurrence IN ('monthly', 'weekly', 'twice_monthly', 'one_off')),
  due_day INTEGER,
  due_days INTEGER[] NOT NULL DEFAULT '{}',
  weekday INTEGER,
  due_date DATE,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS planned_expenses_user_active_idx ON planned_expenses(user_id, active);
ALTER TABLE planned_expenses ADD COLUMN IF NOT EXISTS due_days INTEGER[] NOT NULL DEFAULT '{}';
ALTER TABLE planned_expenses ADD COLUMN IF NOT EXISTS weekday INTEGER;
UPDATE planned_expenses SET due_days = ARRAY[due_day] WHERE due_day IS NOT NULL AND cardinality(due_days) = 0;
UPDATE planned_expenses SET category_slug = 'home' WHERE lower(description) LIKE '%квартир%' AND category_slug = 'food_cafe';
UPDATE planned_expenses SET category_slug = 'education' WHERE lower(description) IN ('english', 'английский') AND category_slug = 'other';

UPDATE planned_expenses
SET amount_base = planned_expenses.amount
FROM users
WHERE users.id = planned_expenses.user_id
  AND users.base_currency = planned_expenses.currency
  AND users.base_currency <> 'THB';

UPDATE planned_expenses
SET amount_base = ROUND(
  planned_expenses.amount
  * CASE planned_expenses.currency
      WHEN 'THB' THEN 1
      WHEN 'USD' THEN 32.65
      WHEN 'RUB' THEN 32.65 / 71.8
      WHEN 'IDR' THEN 32.65 / 16200
      WHEN 'EUR' THEN 32.65 / 0.88
      WHEN 'BYN' THEN 32.65 / 3.25
      WHEN 'GEL' THEN 32.65 / 2.7
      ELSE 1
    END
  / CASE users.base_currency
      WHEN 'THB' THEN 1
      WHEN 'USD' THEN 32.65
      WHEN 'RUB' THEN 32.65 / 71.8
      WHEN 'IDR' THEN 32.65 / 16200
      WHEN 'EUR' THEN 32.65 / 0.88
      WHEN 'BYN' THEN 32.65 / 3.25
      WHEN 'GEL' THEN 32.65 / 2.7
      ELSE 1
    END,
  2
)
FROM users
WHERE users.id = planned_expenses.user_id
  AND users.base_currency <> planned_expenses.currency;

CREATE TABLE IF NOT EXISTS planned_drafts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  source_text TEXT NOT NULL,
  item JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS planned_drafts_user_status_idx ON planned_drafts(user_id, status);

CREATE TABLE IF NOT EXISTS planned_expense_payments (
  id BIGSERIAL PRIMARY KEY,
  planned_expense_id BIGINT NOT NULL REFERENCES planned_expenses(id) ON DELETE CASCADE,
  expense_id BIGINT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  occurrence_date DATE,
  paid_month TEXT NOT NULL,
  paid_key TEXT NOT NULL DEFAULT '',
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(planned_expense_id, paid_key)
);

ALTER TABLE planned_expense_payments ADD COLUMN IF NOT EXISTS occurrence_date DATE;
ALTER TABLE planned_expense_payments ADD COLUMN IF NOT EXISTS paid_key TEXT;
UPDATE planned_expense_payments SET paid_key = paid_month WHERE paid_key IS NULL OR paid_key = '';
UPDATE planned_expense_payments
SET occurrence_date = COALESCE(NULLIF(split_part(paid_key, ':', 2), '')::date, (paid_at + interval '7 hours')::date)
WHERE occurrence_date IS NULL;
ALTER TABLE planned_expense_payments ALTER COLUMN paid_key SET NOT NULL;
ALTER TABLE planned_expense_payments ALTER COLUMN paid_key SET DEFAULT '';
ALTER TABLE planned_expense_payments DROP CONSTRAINT IF EXISTS planned_expense_payments_planned_expense_id_paid_month_key;
CREATE UNIQUE INDEX IF NOT EXISTS planned_expense_payments_key_idx ON planned_expense_payments(planned_expense_id, paid_key);
CREATE UNIQUE INDEX IF NOT EXISTS planned_expense_payments_occurrence_idx ON planned_expense_payments(planned_expense_id, occurrence_date);
CREATE INDEX IF NOT EXISTS planned_expense_payments_month_idx ON planned_expense_payments(planned_expense_id, paid_month);

UPDATE expenses SET budget_impact = 'planned'
WHERE id IN (SELECT expense_id FROM planned_expense_payments)
  AND budget_impact = 'regular';

-- Recompute occurrence_date so it matches the actual due day of each payment.
-- Older rows stored the click time as occurrence_date, which diverged from
-- paid_key and made the (planned_expense_id, occurrence_date) unique index
-- inconsistent with (planned_expense_id, paid_key).
WITH corrected AS (
  SELECT pep.id AS payment_id,
         CASE
           WHEN pe.recurrence IN ('weekly', 'twice_monthly') AND pep.paid_key LIKE '%:%'
             THEN split_part(pep.paid_key, ':', 2)::date
           WHEN pe.recurrence IN ('one_off', 'one_time') AND pe.due_date IS NOT NULL
             THEN pe.due_date
           WHEN pe.recurrence = 'monthly' AND pe.due_day IS NOT NULL
             THEN make_date(
                    split_part(pep.paid_month, '-', 1)::int,
                    split_part(pep.paid_month, '-', 2)::int,
                    LEAST(pe.due_day,
                          EXTRACT(day FROM (date_trunc('month', to_date(pep.paid_month, 'YYYY-MM')) + interval '1 month - 1 day'))::int)
                  )
           ELSE pep.occurrence_date
         END AS occ
  FROM planned_expense_payments pep
  JOIN planned_expenses pe ON pe.id = pep.planned_expense_id
)
UPDATE planned_expense_payments pep
SET occurrence_date = corrected.occ
FROM corrected
WHERE pep.id = corrected.payment_id
  AND corrected.occ IS NOT NULL
  AND pep.occurrence_date IS DISTINCT FROM corrected.occ;

CREATE TABLE IF NOT EXISTS app_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  event_name TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_events_created_at_idx ON app_events(created_at);
CREATE INDEX IF NOT EXISTS app_events_event_created_at_idx ON app_events(event_name, created_at);
CREATE INDEX IF NOT EXISTS app_events_user_created_at_idx ON app_events(user_id, created_at);

CREATE TABLE IF NOT EXISTS weekly_reports (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_key TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, report_key)
);

CREATE TABLE IF NOT EXISTS release_notes (
  id BIGSERIAL PRIMARY KEY,
  version TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'user',
  category TEXT,
  title_ru TEXT NOT NULL,
  title_en TEXT,
  body_ru TEXT NOT NULL,
  body_en TEXT,
  released_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  is_public BOOLEAN NOT NULL DEFAULT true
);

ALTER TABLE release_notes ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'user';
ALTER TABLE release_notes ADD COLUMN IF NOT EXISTS category TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'release_notes_audience_check'
  ) THEN
    ALTER TABLE release_notes
      ADD CONSTRAINT release_notes_audience_check
      CHECK (audience IN ('user', 'admin', 'internal'));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS release_note_deliveries (
  release_note_id BIGINT REFERENCES release_notes(id),
  user_id BIGINT REFERENCES users(id),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (release_note_id, user_id)
);
