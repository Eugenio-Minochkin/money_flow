CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('telegram', 'miniapp')),
  stage TEXT NOT NULL CHECK (stage IN ('requested', 'awaiting_text')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'cancelled', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS account_deletion_requests_one_pending_per_user
  ON account_deletion_requests(user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS account_deletion_requests_user_status_expires_idx
  ON account_deletion_requests(user_id, status, expires_at);

DO $$
DECLARE
  existing_constraint_name TEXT;
  existing_delete_action CHAR;
BEGIN
  SELECT constraint_row.conname, constraint_row.confdeltype
  INTO existing_constraint_name, existing_delete_action
  FROM pg_constraint constraint_row
  JOIN pg_class child_table ON child_table.oid = constraint_row.conrelid
  JOIN pg_class parent_table ON parent_table.oid = constraint_row.confrelid
  JOIN pg_attribute child_column
    ON child_column.attrelid = constraint_row.conrelid
   AND child_column.attnum = ANY(constraint_row.conkey)
  WHERE constraint_row.contype = 'f'
    AND child_table.relname = 'release_note_deliveries'
    AND parent_table.relname = 'users'
    AND child_column.attname = 'user_id'
  LIMIT 1;

  IF existing_constraint_name IS NOT NULL AND existing_delete_action <> 'c' THEN
    EXECUTE format(
      'ALTER TABLE release_note_deliveries DROP CONSTRAINT IF EXISTS %I',
      existing_constraint_name
    );
    existing_constraint_name := NULL;
  END IF;

  IF existing_constraint_name IS NULL THEN
    ALTER TABLE release_note_deliveries
      ADD CONSTRAINT release_note_deliveries_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END
$$;
