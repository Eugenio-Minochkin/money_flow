-- No phrase map or financial rows are created. Exact equality is also checked
-- by the lookup, so a digest collision cannot supply another description's hint.
CREATE INDEX IF NOT EXISTS expenses_user_description_memory_idx
  ON expenses (user_id, md5(lower(btrim(regexp_replace(description, '[[:space:]]+', ' ', 'g')))));
