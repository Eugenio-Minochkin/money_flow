CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL UNIQUE,
  first_name TEXT,
  username TEXT,
  base_currency TEXT NOT NULL DEFAULT 'THB',
  monthly_budget_amount NUMERIC(14, 2) NOT NULL DEFAULT 45000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  due_date DATE,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS planned_expenses_user_active_idx ON planned_expenses(user_id, active);
