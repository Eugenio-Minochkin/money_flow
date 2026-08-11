CREATE TABLE IF NOT EXISTS quick_capture_requests (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_request_id TEXT NOT NULL,
  draft_id BIGINT REFERENCES drafts(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed')),
  claim_version BIGINT NOT NULL DEFAULT 0,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE(user_id, client_request_id)
);

ALTER TABLE quick_access_tokens ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
ALTER TABLE quick_access_tokens ADD COLUMN IF NOT EXISTS prepared_expires_at TIMESTAMPTZ;

UPDATE quick_access_tokens
SET activated_at = created_at
WHERE activated_at IS NULL AND prepared_expires_at IS NULL;

CREATE INDEX IF NOT EXISTS quick_access_tokens_prepared_expiry_idx
  ON quick_access_tokens(prepared_expires_at)
  WHERE activated_at IS NULL AND revoked_at IS NULL;
