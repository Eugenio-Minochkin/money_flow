const SAFE_INPUT_TYPES = new Set(["text", "voice", "photo", "unknown"]);
const SAFE_LANGUAGES = new Set(["ru", "en", "unknown"]);
const SAFE_ACCEPTANCE_LEVELS = new Set(["local_safe", "local_reviewable", "local_rejected", "unknown"]);
const SAFE_REJECT_REASONS = new Set([
  "none",
  "local_exception",
  "unsafe_split_or_mapping",
  "unsupported_amount_shape",
  "unsupported_number_words",
  "no_amount_token",
  "non_expense_intent",
  "unknown"
]);
const CRITICAL_FIELDS = Object.freeze([
  "amount",
  "currency",
  "expense_count",
  "local_calendar_day",
  "budget_impact"
]);

// Existing shadow events deliberately retain only safe comparison flags. They
// do not contain a durable draft link or either parser result, so no historical
// event can be matched to a confirmed expense without an unsafe heuristic.
export const CRITICAL_SHADOW_ADJUDICATION_SQL = `
WITH critical_shadow_events AS (
  SELECT metadata
  FROM app_events
  WHERE event_name = 'message_processing_completed'
    AND metadata->>'criticalShadowDisagreement' = 'true'
), normalized AS (
  SELECT
    CASE metadata->>'inputType'
      WHEN 'text' THEN 'text'
      WHEN 'voice' THEN 'voice'
      WHEN 'photo' THEN 'photo'
      ELSE 'unknown'
    END AS input_type,
    'unknown'::text AS language,
    CASE metadata->>'localAcceptanceLevel'
      WHEN 'local_safe' THEN 'local_safe'
      WHEN 'local_reviewable' THEN 'local_reviewable'
      WHEN 'local_rejected' THEN 'local_rejected'
      ELSE 'unknown'
    END AS acceptance_level,
    CASE
      WHEN metadata->>'localFastPathRejectReason' IS NULL THEN 'none'
      WHEN metadata->>'localFastPathRejectReason' = 'local_exception' THEN 'local_exception'
      WHEN metadata->>'localFastPathRejectReason' = 'unsafe_split_or_mapping' THEN 'unsafe_split_or_mapping'
      WHEN metadata->>'localFastPathRejectReason' = 'unsupported_amount_shape' THEN 'unsupported_amount_shape'
      WHEN metadata->>'localFastPathRejectReason' = 'unsupported_number_words' THEN 'unsupported_number_words'
      WHEN metadata->>'localFastPathRejectReason' = 'no_amount_token' THEN 'no_amount_token'
      WHEN metadata->>'localFastPathRejectReason' = 'non_expense_intent' THEN 'non_expense_intent'
      ELSE 'unknown'
    END AS reject_reason,
    (metadata->'shadowDisagreementFields' ? 'amount') AS amount_disagreement,
    (metadata->'shadowDisagreementFields' ? 'currency') AS currency_disagreement,
    (metadata->'shadowDisagreementFields' ? 'expense_count') AS expense_count_disagreement,
    (metadata->'shadowDisagreementFields' ? 'spent_at') AS local_calendar_day_disagreement,
    (metadata->'shadowDisagreementFields' ? 'budget_impact') AS budget_impact_disagreement
  FROM critical_shadow_events
)
SELECT
  input_type,
  language,
  acceptance_level,
  reject_reason,
  'unadjudicable'::text AS result_category,
  COUNT(*)::int AS critical_disagreement_count,
  COUNT(*) FILTER (WHERE amount_disagreement)::int AS amount_disagreement_count,
  COUNT(*) FILTER (WHERE currency_disagreement)::int AS currency_disagreement_count,
  COUNT(*) FILTER (WHERE expense_count_disagreement)::int AS expense_count_disagreement_count,
  COUNT(*) FILTER (WHERE local_calendar_day_disagreement)::int AS local_calendar_day_disagreement_count,
  COUNT(*) FILTER (WHERE budget_impact_disagreement)::int AS budget_impact_disagreement_count
FROM normalized
GROUP BY input_type, language, acceptance_level, reject_reason
ORDER BY input_type, language, acceptance_level, reject_reason
`;

export function assertSafeShadowAdjudicationSql(sql) {
  const normalized = String(sql ?? "").replace(/'(?:''|[^'])*'/gu, "''").trim();
  const withoutTrailingSemicolon = normalized.replace(/;\s*$/u, "").trim();
  if (!/^WITH\b/iu.test(withoutTrailingSemicolon)
      || /;/u.test(withoutTrailingSemicolon)
      || /\b(?:INSERT|UPDATE|DELETE|MERGE|UPSERT|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|LOCK|VACUUM|ANALYZE|COMMENT|REFRESH)\b/iu.test(withoutTrailingSemicolon)
      || /\bFOR\s+(?:UPDATE|SHARE)\b/iu.test(withoutTrailingSemicolon)) {
    throw new Error("unsafe_shadow_adjudication_sql");
  }
  return sql;
}

export function buildHistoricalShadowAdjudicationReport(rows = [], { sourceKind = "unknown" } = {}) {
  const resultCategories = { local_match: 0, llm_match: 0, neither_match: 0, unadjudicable: 0 };
  const lifecycleCounts = { confirmed: 0, cancelled: 0, unconfirmed: 0, unlinked: 0 };
  const criticalFieldCounts = Object.fromEntries(CRITICAL_FIELDS.map((field) => [field, 0]));
  const groups = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const count = safeCount(row?.critical_disagreement_count);
    if (count === 0) continue;
    const group = {
      inputType: safeEnum(row?.input_type, SAFE_INPUT_TYPES),
      language: safeEnum(row?.language, SAFE_LANGUAGES),
      acceptanceLevel: safeEnum(row?.acceptance_level, SAFE_ACCEPTANCE_LEVELS),
      rejectReason: safeEnum(row?.reject_reason, SAFE_REJECT_REASONS),
      resultCategory: "unadjudicable",
      count
    };
    resultCategories.unadjudicable += count;
    lifecycleCounts.unlinked += count;
    for (const field of CRITICAL_FIELDS) {
      criticalFieldCounts[field] += safeCount(row?.[`${field}_disagreement_count`]);
    }
    groups.push(group);
  }

  groups.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
  return {
    schemaVersion: 1,
    sourceKind: sourceKind === "local-copy" || sourceKind === "read-replica" ? sourceKind : "unknown",
    historicalCorrelation: "unavailable",
    resultCategories,
    lifecycleCounts,
    criticalFieldCounts,
    groups
  };
}

function safeEnum(value, allowed) {
  const normalized = String(value ?? "").toLowerCase();
  return allowed.has(normalized) ? normalized : "unknown";
}

function safeCount(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}
