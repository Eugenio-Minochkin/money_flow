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
  budget_advice_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS display_currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE users ADD COLUMN IF NOT EXISTS usd_thb_rate NUMERIC(14, 6) NOT NULL DEFAULT 32.65;
ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_budget_amount NUMERIC(14, 2);
ALTER TABLE users ADD COLUMN IF NOT EXISTS interface_language TEXT NOT NULL DEFAULT 'en';
ALTER TABLE users ADD COLUMN IF NOT EXISTS budget_advice_enabled BOOLEAN NOT NULL DEFAULT true;
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

CREATE INDEX IF NOT EXISTS expenses_user_spent_at_idx ON expenses(user_id, spent_at DESC);
CREATE INDEX IF NOT EXISTS drafts_user_status_idx ON drafts(user_id, status);

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

CREATE TABLE IF NOT EXISTS planned_expense_payments (
  id BIGSERIAL PRIMARY KEY,
  planned_expense_id BIGINT NOT NULL REFERENCES planned_expenses(id) ON DELETE CASCADE,
  expense_id BIGINT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  paid_month TEXT NOT NULL,
  paid_key TEXT NOT NULL DEFAULT '',
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(planned_expense_id, paid_key)
);

ALTER TABLE planned_expense_payments ADD COLUMN IF NOT EXISTS paid_key TEXT;
UPDATE planned_expense_payments SET paid_key = paid_month WHERE paid_key IS NULL OR paid_key = '';
ALTER TABLE planned_expense_payments ALTER COLUMN paid_key SET NOT NULL;
ALTER TABLE planned_expense_payments ALTER COLUMN paid_key SET DEFAULT '';
ALTER TABLE planned_expense_payments DROP CONSTRAINT IF EXISTS planned_expense_payments_planned_expense_id_paid_month_key;
CREATE UNIQUE INDEX IF NOT EXISTS planned_expense_payments_key_idx ON planned_expense_payments(planned_expense_id, paid_key);
CREATE INDEX IF NOT EXISTS planned_expense_payments_month_idx ON planned_expense_payments(planned_expense_id, paid_month);

CREATE TABLE IF NOT EXISTS weekly_reports (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_key TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, report_key)
);
