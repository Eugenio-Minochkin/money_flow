WITH ranked_active_tokens AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY activated_at DESC, created_at DESC, id DESC) AS active_rank
  FROM quick_access_tokens
  WHERE activated_at IS NOT NULL AND revoked_at IS NULL
)
UPDATE quick_access_tokens AS token
SET revoked_at = now()
FROM ranked_active_tokens
WHERE token.id = ranked_active_tokens.id
  AND ranked_active_tokens.active_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS quick_access_tokens_one_active_per_user_idx
  ON quick_access_tokens(user_id)
  WHERE activated_at IS NOT NULL AND revoked_at IS NULL;
