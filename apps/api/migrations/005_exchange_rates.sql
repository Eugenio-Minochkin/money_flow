CREATE TABLE IF NOT EXISTS exchange_rates (
  id BIGSERIAL PRIMARY KEY,
  rate_date DATE NOT NULL,
  base_currency TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  rate NUMERIC(18, 8) NOT NULL CHECK (rate > 0),
  provider TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(rate_date, base_currency, quote_currency)
);

CREATE INDEX IF NOT EXISTS exchange_rates_pair_date_idx
  ON exchange_rates(base_currency, quote_currency, rate_date DESC);
