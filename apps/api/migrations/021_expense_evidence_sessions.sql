CREATE TABLE IF NOT EXISTS expense_evidence_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_chat_id BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('collecting', 'finalizing', 'ready', 'cancelled', 'expired')),
  claim_version BIGINT NOT NULL DEFAULT 0,
  lease_expires_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS expense_evidence_sessions_one_collecting_per_chat_idx
  ON expense_evidence_sessions(user_id, source_chat_id)
  WHERE status = 'collecting';

CREATE INDEX IF NOT EXISTS expense_evidence_sessions_expiry_idx
  ON expense_evidence_sessions(status, expires_at)
  WHERE status = 'collecting';

CREATE TABLE IF NOT EXISTS expense_evidence_session_imports (
  session_id BIGINT NOT NULL REFERENCES expense_evidence_sessions(id) ON DELETE CASCADE,
  import_id BIGINT NOT NULL REFERENCES expense_evidence_imports(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id, import_id),
  UNIQUE(session_id, ordinal)
);

CREATE INDEX IF NOT EXISTS expense_evidence_session_imports_import_idx
  ON expense_evidence_session_imports(import_id);
