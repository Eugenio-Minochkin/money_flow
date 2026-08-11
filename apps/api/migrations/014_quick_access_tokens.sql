CREATE TABLE IF NOT EXISTS quick_access_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS quick_access_tokens_active_hash_idx
  ON quick_access_tokens(token_hash) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS quick_access_requests (
  id BIGSERIAL PRIMARY KEY,
  token_id BIGINT NOT NULL REFERENCES quick_access_tokens(id) ON DELETE CASCADE,
  client_request_id TEXT NOT NULL,
  draft_id BIGINT REFERENCES drafts(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE(token_id, client_request_id)
);
