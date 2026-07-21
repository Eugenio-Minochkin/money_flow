import { CATEGORIES } from "../../../packages/shared/src/categories.js";

export const DEFAULT_AUDIT_THRESHOLDS = Object.freeze({
  minCount: 3,
  minDistinctUsers: 2,
  dominanceThreshold: 0.8
});

export const HISTORICAL_AUDIT_SQL = `
SELECT
  d.id AS draft_id,
  d.user_id,
  d.status AS draft_status,
  d.source_text,
  d.items,
  COALESCE(
    jsonb_agg(
      jsonb_build_object('category_slug', e.category_slug)
      ORDER BY e.id
    ) FILTER (WHERE e.id IS NOT NULL),
    '[]'::jsonb
  ) AS confirmed_expenses
FROM drafts d
LEFT JOIN expenses e
  ON e.draft_id = d.id
 AND e.budget_impact = 'regular'
WHERE d.status IN ('pending', 'cancelled', 'inbox')
   OR (d.status = 'confirmed' AND e.id IS NOT NULL)
GROUP BY d.id, d.user_id, d.status, d.source_text, d.items
ORDER BY d.id
`;

const LANGUAGES = ["ru", "en"];
const KNOWN_CATEGORY_SLUGS = new Set(CATEGORIES.map((category) => category.slug));
const SUPPORTED_ALIASES = new Map(CATEGORIES.flatMap((category) =>
  category.keywords.map((keyword) => [normalizeAlias(keyword), category.slug])
));
const FINANCIAL_TOKENS = new Set([
  "byn", "eur", "gel", "idr", "rub", "thb", "usd",
  "baht", "dollar", "dollars", "euro", "euros", "lari",
  "rouble", "roubles", "ruble", "rubles", "rupiah",
  "бат", "бата", "батов", "доллар", "доллара", "долларов",
  "евро", "лари", "рубль", "рубля", "рублей", "рупий", "рупия", "рупии"
]);
const NUMBER_WORD_TOKENS = new Set([
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
  "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
  "hundred", "hundreds", "thousand", "thousands", "million", "millions", "billion", "billions",
  "trillion", "trillions",
  "ноль", "один", "одна", "одно", "одни", "два", "две", "три", "четыре", "пять",
  "шесть", "семь", "восемь", "девять", "десять", "одиннадцать", "двенадцать", "тринадцать",
  "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать",
  "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто",
  "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот",
  "тысяча", "тысячи", "тысяч", "миллион", "миллиона", "миллионов", "миллиард", "миллиарда", "миллиардов"
]);
const NUMBER_WORD_CONNECTORS = new Set(["and", "и"]);
const RU_NUMBER_MORPHOLOGY_PATTERNS = [
  /^одн(?:а|о|у|ой|ою|е|и|их|им|ими|ого|ому)$/u,
  /^полтор(?:а|ы|у|ой|ою|ых|ым|ыми)$/u,
  /^дв(?:а|е|ух|ум|умя|оих|оим|оими)$/u,
  /^тр(?:и|ех|ёх|ем|ём|емя)$/u,
  /^четыр(?:е|ех|ёх|ем|ём|ьмя)$/u,
  /^(?:пят|шест|сем|восем|девят|десят)(?:ь|и|ью)$/u,
  /^(?:одиннадцат|двенадцат|тринадцат|четырнадцат|пятнадцат|шестнадцат|семнадцат|восемнадцат|девятнадцат|двадцат|тридцат)(?:ь|и|ью)$/u,
  /^тысяч(?:а|у|и|е|ей|ам|ами|ах)?$/u,
  /^миллион(?:а|у|ом|е|ы|ов|ам|ами|ах)?$/u,
  /^миллиард(?:а|у|ом|е|ы|ов|ам|ами|ах)?$/u
];

export function normalizeAuditThresholds(input = {}) {
  const thresholds = {
    minCount: input.minCount ?? DEFAULT_AUDIT_THRESHOLDS.minCount,
    minDistinctUsers: input.minDistinctUsers ?? DEFAULT_AUDIT_THRESHOLDS.minDistinctUsers,
    dominanceThreshold: input.dominanceThreshold ?? DEFAULT_AUDIT_THRESHOLDS.dominanceThreshold
  };

  if (!Number.isInteger(thresholds.minCount)
      || thresholds.minCount < DEFAULT_AUDIT_THRESHOLDS.minCount
      || !Number.isInteger(thresholds.minDistinctUsers)
      || thresholds.minDistinctUsers < DEFAULT_AUDIT_THRESHOLDS.minDistinctUsers
      || !Number.isFinite(thresholds.dominanceThreshold)
      || thresholds.dominanceThreshold < DEFAULT_AUDIT_THRESHOLDS.dominanceThreshold
      || thresholds.dominanceThreshold > 1) {
    throw new Error("invalid_audit_thresholds");
  }

  return thresholds;
}

export function assertReadOnlyAuditSql(sql) {
  const normalized = stripSqlLiteralsAndComments(sql).trim();
  const withoutTrailingSemicolon = normalized.replace(/;\s*$/u, "").trim();
  if (!/^SELECT\b/iu.test(withoutTrailingSemicolon)
      || /;/u.test(withoutTrailingSemicolon)
      || /\b(?:INSERT|UPDATE|DELETE|MERGE|UPSERT|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|LOCK|VACUUM|ANALYZE|COMMENT|REFRESH)\b/iu.test(withoutTrailingSemicolon)
      || /\bFOR\s+(?:UPDATE|SHARE)\b/iu.test(withoutTrailingSemicolon)) {
    throw new Error("unsafe_audit_sql");
  }
  return sql;
}

export function buildParserAuditReport(rows = [], options = {}) {
  const thresholds = normalizeAuditThresholds(options);
  const aggregates = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    for (const evidence of evidenceFromRow(row)) {
      for (const candidate of extractSafeCandidates(evidence.text)) {
        const key = `${candidate.language}\u0000${candidate.phrase}`;
        const aggregate = aggregates.get(key) ?? {
          language: candidate.language,
          phrase: candidate.phrase,
          confirmedCount: 0,
          confirmedUsers: new Set(),
          categories: new Map(),
          reviewOnlyCount: 0,
          reviewOnlyUsers: new Set(),
          ambiguousCount: 0
        };
        if (evidence.confirmed) {
          aggregate.confirmedCount += 1;
          aggregate.confirmedUsers.add(String(row?.user_id ?? ""));
        }
        if (evidence.category) {
          aggregate.categories.set(
            evidence.category,
            (aggregate.categories.get(evidence.category) ?? 0) + 1
          );
        }
        if (evidence.reviewOnly) {
          aggregate.reviewOnlyCount += 1;
          aggregate.reviewOnlyUsers.add(String(row?.user_id ?? ""));
        }
        if (evidence.ambiguous) aggregate.ambiguousCount += 1;
        aggregates.set(key, aggregate);
      }
    }
  }

  const candidates = { ru: [], en: [] };
  for (const aggregate of aggregates.values()) {
    const confirmedQualified = aggregate.confirmedCount >= thresholds.minCount
      && aggregate.confirmedUsers.size >= thresholds.minDistinctUsers;
    const reviewOnlyQualified = aggregate.reviewOnlyCount >= thresholds.minCount
      && aggregate.reviewOnlyUsers.size >= thresholds.minDistinctUsers;
    if (!confirmedQualified && !reviewOnlyQualified) continue;
    candidates[aggregate.language].push(formatCandidate(
      aggregate,
      thresholds,
      { confirmedQualified, reviewOnlyQualified }
    ));
  }

  for (const language of LANGUAGES) {
    candidates[language].sort((left, right) => left.phrase.localeCompare(right.phrase, language));
  }

  const statusCounts = {
    already_supported: 0,
    manual_review: 0,
    rejected_ambiguous: 0
  };
  for (const candidate of [...candidates.ru, ...candidates.en]) {
    statusCounts[candidate.decision] += 1;
  }

  return {
    schemaVersion: 1,
    sourceKind: normalizeSourceKind(options.sourceKind),
    thresholds,
    languages: {
      ru: { qualifiedCandidateCount: candidates.ru.length },
      en: { qualifiedCandidateCount: candidates.en.length }
    },
    candidates,
    statusCounts
  };
}

function evidenceFromRow(row) {
  const status = String(row?.draft_status ?? row?.status ?? "").toLowerCase();
  const items = parseJsonArray(row?.items);
  const expenses = parseJsonArray(row?.confirmed_expenses);
  const sourceText = String(row?.source_text ?? "");

  if (status !== "confirmed") {
    return [{ text: sourceText, category: null, confirmed: false, reviewOnly: true, ambiguous: false }];
  }
  if (expenses.length === 0) return [];

  if (items.length === expenses.length) {
    return items.map((item, index) => ({
      text: items.length === 1 ? sourceText : item?.description,
      category: normalizeCategory(expenses[index]?.category_slug),
      confirmed: true,
      reviewOnly: false,
      ambiguous: !normalizeCategory(expenses[index]?.category_slug)
    }));
  }

  return [{ text: sourceText, category: null, confirmed: true, reviewOnly: false, ambiguous: true }];
}

function extractSafeCandidates(value) {
  const sanitized = String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replaceAll("ё", "е")
    .replaceAll(/\b(?:https?:\/\/|www\.)\S+/giu, " ")
    .replaceAll(/\b\S+@\S+\b/gu, " ")
    .replaceAll(/(?<![\p{L}\p{N}_])@[\p{L}\p{N}_.-]+/gu, " ")
    .replaceAll(/\b(?:[\p{L}\p{N}-]+\.)+[a-zа-я]{2,}(?:\/\S*)?/giu, " ")
    .replaceAll(/\b(?=[\p{L}\p{N}_-]*\p{N})[\p{L}\p{N}_-]{2,}\b/gu, " ")
    .replaceAll(/\p{N}+(?:[.,:/-]\p{N}+)*\p{Sc}?/gu, " ");
  const tokens = removeNumberWordSequences(sanitized.match(/[\p{L}]+/gu) ?? []);
  const candidates = [];
  let currentLanguage = null;
  let currentTokens = [];

  const flush = () => {
    const phrase = currentTokens.slice(0, 3).join(" ").slice(0, 48).trim();
    if (currentLanguage && phrase) candidates.push({ language: currentLanguage, phrase });
    currentLanguage = null;
    currentTokens = [];
  };

  for (const token of tokens) {
    const language = detectTokenLanguage(token);
    if (!language || token.length > 20 || FINANCIAL_TOKENS.has(token)) {
      flush();
      continue;
    }
    if (currentLanguage && currentLanguage !== language) flush();
    currentLanguage = language;
    currentTokens.push(token);
  }
  flush();

  return candidates;
}

function formatCandidate(aggregate, thresholds, { confirmedQualified, reviewOnlyQualified }) {
  const distributionEntries = (confirmedQualified ? [...aggregate.categories.entries()] : [])
    .sort(([left], [right]) => left.localeCompare(right));
  const categoryDistribution = Object.fromEntries(distributionEntries);
  const confirmedCount = distributionEntries.reduce((sum, [, count]) => sum + count, 0);
  const dominantEntry = [...distributionEntries]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
  const dominantCategory = dominantEntry?.[0] ?? null;
  const dominance = confirmedCount > 0 ? dominantEntry[1] / confirmedCount : null;
  let decision = "manual_review";
  if (confirmedQualified && (aggregate.ambiguousCount > 0
      || (dominance !== null && dominance < thresholds.dominanceThreshold))) {
    decision = "rejected_ambiguous";
  } else if (confirmedQualified
      && dominantCategory
      && SUPPORTED_ALIASES.get(aggregate.phrase) === dominantCategory) {
    decision = "already_supported";
  }

  return {
    phrase: aggregate.phrase,
    decision,
    dominantCategory,
    dominance,
    occurrenceCount: confirmedQualified ? aggregate.confirmedCount : aggregate.reviewOnlyCount,
    distinctUsers: confirmedQualified ? aggregate.confirmedUsers.size : aggregate.reviewOnlyUsers.size,
    reviewOnlyCount: reviewOnlyQualified ? aggregate.reviewOnlyCount : 0,
    categoryDistribution
  };
}

function removeNumberWordSequences(tokens) {
  const filtered = [];
  for (let index = 0; index < tokens.length;) {
    if (!isNumberWordToken(tokens[index])) {
      filtered.push(tokens[index]);
      index += 1;
      continue;
    }

    index += 1;
    while (index < tokens.length) {
      if (isNumberWordToken(tokens[index])) {
        index += 1;
        continue;
      }
      if (NUMBER_WORD_CONNECTORS.has(tokens[index])
          && isNumberWordToken(tokens[index + 1])) {
        index += 2;
        continue;
      }
      break;
    }
  }
  return filtered;
}

function isNumberWordToken(token) {
  return NUMBER_WORD_TOKENS.has(token)
    || RU_NUMBER_MORPHOLOGY_PATTERNS.some((pattern) => pattern.test(token));
}

function detectTokenLanguage(token) {
  if (/^\p{Script=Cyrillic}+$/u.test(token)) return "ru";
  if (/^\p{Script=Latin}+$/u.test(token)) return "en";
  return null;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeCategory(value) {
  const category = String(value ?? "").trim();
  return KNOWN_CATEGORY_SLUGS.has(category) ? category : null;
}

function normalizeSourceKind(value) {
  return value === "local-copy" || value === "read-replica" ? value : "unspecified";
}

function normalizeAlias(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replaceAll("ё", "е")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function stripSqlLiteralsAndComments(sql) {
  return String(sql ?? "")
    .replaceAll(/--[^\r\n]*/gu, " ")
    .replaceAll(/\/\*[\s\S]*?\*\//gu, " ")
    .replaceAll(/'(?:''|[^'])*'/gu, "''")
    .replaceAll(/"(?:""|[^"])*"/gu, '""');
}
