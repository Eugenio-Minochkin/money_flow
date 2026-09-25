import { CATEGORIES } from "../../../packages/shared/src/categories.js";

const CATEGORIES_WITH_HINTS = new Set(CATEGORIES.map(({ slug }) => slug).filter((slug) => slug !== "other"));
const LOOKUP_BUDGET_MS = 100;

// Match the index expression exactly. The digest bounds index size; equality
// below still compares the complete normalized description, not the digest.
export const CATEGORY_MEMORY_QUERY = `
  SELECT e.draft_id, e.category_slug,
    (d.status = 'confirmed' AND jsonb_array_length(d.items) = 1
      AND d.items->0->>'category_source' = 'user'
      AND d.items->0->>'category_slug' = e.category_slug
      AND d.items->0->>'description' = e.description
      AND COALESCE(e.budget_impact, 'regular') = 'regular') AS eligible
  FROM expenses e
  LEFT JOIN drafts d ON d.id = e.draft_id AND d.user_id = e.user_id
  WHERE e.user_id = $1
    AND md5(lower(btrim(regexp_replace(e.description, '[[:space:]]+', ' ', 'g'))))
      = md5(lower(btrim(regexp_replace($2::text, '[[:space:]]+', ' ', 'g'))))
    AND lower(btrim(regexp_replace(e.description, '[[:space:]]+', ' ', 'g')))
      = lower(btrim(regexp_replace($2::text, '[[:space:]]+', ' ', 'g')))
  LIMIT 101`;

export function createCategoryMemoryLookup(pool) {
  return async ({ userId, description }) => {
    if (!/^[1-9]\d*$/.test(String(userId ?? "")) || typeof description !== "string"
      || !description.trim() || description.length > 160) return null;
    let client;
    let expired = false;
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error("category_memory_timeout")); }, LOOKUP_BUDGET_MS);
    });
    try {
      client = await Promise.race([
        pool.connect().then((connected) => {
          if (expired) { connected.release(); return null; }
          return connected;
        }),
        deadline
      ]);
      const { rows } = await Promise.race([
        client.query({ text: CATEGORY_MEMORY_QUERY, values: [String(userId), description], query_timeout: LOOKUP_BUDGET_MS }),
        deadline
      ]);
      if (rows.length > 100 || rows.length < 3) return null;
      const category = rows[0].category_slug;
      if (!CATEGORIES_WITH_HINTS.has(category) || rows.some((row) => row.category_slug !== category)) return null;
      const confirmedDrafts = new Set(rows.filter((row) => row.eligible === true && row.draft_id != null).map((row) => String(row.draft_id)));
      return confirmedDrafts.size >= 3 ? category : null;
    } catch {
      // Never log descriptions or provider/database errors. Destroy a client
      // with unfinished SQL so a timed-out hint cannot hold the shared pool.
      client?.release(true);
      client = null;
      return null;
    } finally {
      clearTimeout(timer);
      client?.release();
    }
  };
}
