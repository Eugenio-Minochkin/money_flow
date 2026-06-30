CREATE TABLE IF NOT EXISTS budget_topup_drafts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired')),
  source_text TEXT NOT NULL,
  item JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS budget_topup_drafts_user_status_idx
  ON budget_topup_drafts(user_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS budget_topup_drafts_one_pending_per_user
  ON budget_topup_drafts(user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS budget_topup_drafts_user_created_idx
  ON budget_topup_drafts(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS budget_topups (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_id BIGINT REFERENCES budget_topup_drafts(id) ON DELETE SET NULL,
  month_key TEXT NOT NULL,
  local_date DATE NOT NULL,
  amount_original NUMERIC(14, 2) NOT NULL CHECK (amount_original > 0),
  currency_original TEXT NOT NULL,
  amount_base NUMERIC(14, 2) NOT NULL CHECK (amount_base > 0),
  base_currency TEXT NOT NULL,
  converted_amounts JSONB NOT NULL DEFAULT '{}'::jsonb,
  exchange_rate_date DATE NOT NULL,
  exchange_rate_source TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('income', 'refund', 'other')),
  note TEXT,
  source_text TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS budget_topups_user_draft_unique
  ON budget_topups(user_id, draft_id)
  WHERE draft_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS budget_topups_user_month_idx
  ON budget_topups(user_id, month_key)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS budget_topups_user_occurred_idx
  ON budget_topups(user_id, occurred_at DESC)
  WHERE deleted_at IS NULL;
