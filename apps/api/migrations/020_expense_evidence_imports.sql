CREATE TABLE IF NOT EXISTS expense_evidence_imports (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_chat_id BIGINT NOT NULL,
  source_message_id BIGINT NOT NULL,
  image_bytes_hmac TEXT NOT NULL,
  telegram_file_hmac TEXT,
  candidate_set_hmac TEXT,
  status TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'failed', 'cancelled', 'completed')),
  claim_version BIGINT NOT NULL DEFAULT 0,
  lease_expires_at TIMESTAMPTZ,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE(user_id, source_chat_id, source_message_id)
);

CREATE INDEX IF NOT EXISTS expense_evidence_imports_unfinished_idx
  ON expense_evidence_imports(user_id, status, created_at DESC)
  WHERE status IN ('processing', 'ready');

CREATE INDEX IF NOT EXISTS expense_evidence_imports_image_hmac_idx
  ON expense_evidence_imports(user_id, image_bytes_hmac)
  WHERE status IN ('ready', 'completed');

CREATE INDEX IF NOT EXISTS expense_evidence_imports_file_hmac_idx
  ON expense_evidence_imports(user_id, telegram_file_hmac)
  WHERE telegram_file_hmac IS NOT NULL AND status IN ('ready', 'completed');

CREATE TABLE IF NOT EXISTS expense_evidence_candidates (
  id BIGSERIAL PRIMARY KEY,
  import_id BIGINT NOT NULL REFERENCES expense_evidence_imports(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('bank_transactions', 'receipt', 'order_confirmation', 'payment_confirmation')),
  draft_id BIGINT REFERENCES drafts(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'reviewing', 'saved', 'already_accounted', 'cancelled', 'likely_duplicate')),
  dedupe_classification TEXT NOT NULL CHECK (dedupe_classification IN ('new', 'possible_duplicate', 'likely_duplicate')),
  dedupe_reason_code TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(import_id, ordinal)
);

CREATE INDEX IF NOT EXISTS expense_evidence_candidates_unresolved_idx
  ON expense_evidence_candidates(import_id, status, ordinal)
  WHERE status IN ('ready', 'reviewing');

CREATE INDEX IF NOT EXISTS expense_evidence_candidates_draft_idx
  ON expense_evidence_candidates(draft_id)
  WHERE draft_id IS NOT NULL;
