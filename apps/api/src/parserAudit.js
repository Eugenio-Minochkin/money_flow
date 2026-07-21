import { CATEGORIES } from "../../../packages/shared/src/categories.js";
import { isCurrencyAlias } from "../../../packages/shared/src/parser.js";

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
const QUANTITY_WORD_TOKENS = new Set([
  "zero", "half", "halves", "quarter", "quarters", "dozen", "dozens", "score", "scores",
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
  "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
  "hundred", "hundreds", "thousand", "thousands", "million", "millions", "billion", "billions",
  "trillion", "trillions",
  "zeroth", "zeroths", "first", "firsts", "second", "seconds", "third", "thirds",
  "fourth", "fourths", "fifth", "fifths", "sixth", "sixths", "seventh", "sevenths",
  "eighth", "eighths", "ninth", "ninths", "tenth", "tenths", "eleventh", "elevenths",
  "twelfth", "twelfths", "thirteenth", "thirteenths", "fourteenth", "fourteenths",
  "fifteenth", "fifteenths", "sixteenth", "sixteenths", "seventeenth", "seventeenths",
  "eighteenth", "eighteenths", "nineteenth", "nineteenths", "twentieth", "twentieths",
  "thirtieth", "thirtieths", "fortieth", "fortieths", "fiftieth", "fiftieths",
  "sixtieth", "sixtieths", "seventieth", "seventieths", "eightieth", "eightieths",
  "ninetieth", "ninetieths", "hundredth", "hundredths", "thousandth", "thousandths",
  "millionth", "millionths", "billionth", "billionths", "trillionth", "trillionths",
  "both", "pair", "couple", "single", "double", "triple", "quadruple", "once", "twice", "thrice",
  "ноль", "один", "одна", "одно", "одни", "два", "две", "три", "четыре", "пять",
  "шесть", "семь", "восемь", "девять", "десять", "одиннадцать", "двенадцать", "тринадцать",
  "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать",
  "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто",
  "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот",
  "тысяча", "тысячи", "тысяч", "миллион", "миллиона", "миллионов", "миллиард", "миллиарда", "миллиардов",
  "триллион", "триллиона", "триллионов", "пол", "полтораста", "полсотни", "полтысячи", "полмиллиона", "полмиллиарда", "полтриллиона",
  "половина", "половины", "половину", "половиной", "половине", "половин", "половинами", "половинах",
  "четверть", "четверти", "четвертью", "четвертей", "четвертям", "четвертями", "четвертях",
  "треть", "трети", "третью", "третей", "третям", "третями", "третях",
  "пара", "пары", "пару", "паре", "парой", "парою", "пар", "парам", "парами", "парах",
  "дюжина", "дюжины", "дюжину", "дюжине", "дюжиной", "дюжиною", "дюжин", "дюжинам", "дюжинами", "дюжинах",
  "оба", "обе", "обоих", "обеих", "обоим", "обеим", "обоими", "обеими"
]);
const RU_QUANTITY_MORPHOLOGY_PATTERNS = [
  /^полутора$/u,
  /^(?:двух|трех|четырех|пяти|шести|семи|восьми|девяти)сот$/u,
  /^(?:двум|трем|четырем|пяти|шести|семи|восьми|девяти)стам$/u,
  /^(?:двумя|тремя|четырьмя|пятью|шестью|семью|восемью|девятью)стами$/u,
  /^(?:двух|трех|четырех|пяти|шести|семи|восьми|девяти)стах$/u,
  /^с(?:та|отни|отен|отне|отню|отней|отнями|отнях)$/u,
  /^(?:двадцати|тридцати|сорока|пятидесяти|шестидесяти|семидесяти|восьмидесяти|девяноста)$/u,
  /^(?:двадцатью|тридцатью|пятьюдесятью|шестьюдесятью|семьюдесятью|восемьюдесятью)$/u,
  /^одн(?:а|о|у|ой|ою|е|и|их|им|ими|ого|ому)$/u,
  /^полтор(?:а|ы|у|ой|ою|ых|ым|ыми)$/u,
  /^дв(?:а|е|ух|ум|умя|оих|оим|оими)$/u,
  /^тр(?:и|ех|ёх|ем|ём|емя)$/u,
  /^четыр(?:е|ех|ёх|ем|ём|ьмя)$/u,
  /^(?:пят|шест|сем|восем|девят|десят)(?:ь|и|ью)$/u,
  /^(?:одиннадцат|двенадцат|тринадцат|четырнадцат|пятнадцат|шестнадцат|семнадцат|восемнадцат|девятнадцат|двадцат|тридцат)(?:ь|и|ью)$/u,
  /^тысяч(?:а|у|и|е|ей|ам|ами|ах)?$/u,
  /^миллион(?:а|у|ом|е|ы|ов|ам|ами|ах)?$/u,
  /^миллиард(?:а|у|ом|е|ы|ов|ам|ами|ах)?$/u,
  /^триллион(?:а|у|ом|е|ы|ов|ам|ами|ах)?$/u,
  /^пол(?:сотни|тысячи|миллиона|миллиарда|триллиона)$/u,
  /^перв(?:ый|ая|ое|ые|ого|ой|ому|ую|ым|ом|ых|ыми)$/u,
  /^втор(?:ой|ая|ое|ые|ого|ой|ому|ую|ым|ом|ых|ыми)$/u,
  /^трет(?:ий|ья|ье|ьи|ьего|ьей|ьему|ью|ьим|ьем|ьих|ьими)$/u,
  /^(?:нулев|четверт|пят|шест|седьм|восьм|девят|десят|одиннадцат|двенадцат|тринадцат|четырнадцат|пятнадцат|шестнадцат|семнадцат|восемнадцат|девятнадцат|двадцат|тридцат|сороков|пятидесят|шестидесят|семидесят|восьмидесят|девяност|сот|тысячн|миллионн|миллиардн|триллионн)(?:ый|ая|ое|ые|ого|ой|ому|ую|ым|ом|ых|ыми)$/u,
  /^(?:двух|трех|четырех|пяти|шести|семи|восьми|девяти)сот(?:ый|ая|ое|ые|ого|ой|ому|ую|ым|ом|ых|ыми)$/u
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
  const sourceSummary = {
    languageCounts: { ru: 0, en: 0, mixed: 0, unknown: 0 },
    statusCounts: { pending: 0, confirmed: 0, inbox: 0, cancelled: 0, unknown: 0 }
  };
  let ambiguousMappingCount = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    sourceSummary.languageCounts[detectSourceLanguage(row?.source_text)] += 1;
    sourceSummary.statusCounts[normalizeDraftStatus(row?.draft_status ?? row?.status)] += 1;
    const rowEvidence = evidenceFromRow(row);
    ambiguousMappingCount += rowEvidence.ambiguousMappingCount;
    for (const evidence of rowEvidence.evidence) {
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
    schemaVersion: 2,
    sourceKind: normalizeSourceKind(options.sourceKind),
    thresholds,
    sourceSummary,
    ambiguousMappingCount,
    languages: {
      ru: { qualifiedCandidateCount: candidates.ru.length },
      en: { qualifiedCandidateCount: candidates.en.length }
    },
    candidates,
    statusCounts
  };
}

function evidenceFromRow(row) {
  const status = normalizeDraftStatus(row?.draft_status ?? row?.status);
  const items = parseJsonArray(row?.items);
  const expenses = parseJsonArray(row?.confirmed_expenses);

  if (["pending", "inbox", "cancelled"].includes(status)) {
    return {
      evidence: items.map((item) => ({
        text: item?.description,
        category: null,
        confirmed: false,
        reviewOnly: true,
        ambiguous: false
      })),
      ambiguousMappingCount: 0
    };
  }
  if (status !== "confirmed" || expenses.length === 0) {
    return { evidence: [], ambiguousMappingCount: 0 };
  }

  if (items.length === expenses.length) {
    return {
      evidence: items.map((item, index) => ({
        text: item?.description,
        category: normalizeCategory(expenses[index]?.category_slug),
        confirmed: true,
        reviewOnly: false,
        ambiguous: !normalizeCategory(expenses[index]?.category_slug)
      })),
      ambiguousMappingCount: 0
    };
  }

  return { evidence: [], ambiguousMappingCount: 1 };
}

function extractSafeCandidates(value) {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replaceAll("ё", "е");
  if (containsSensitiveMarker(normalized)) return [];

  const tokens = normalized.match(/[\p{L}]+/gu) ?? [];
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
    if (!language) {
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

function isSensitiveQuantityToken(token) {
  return QUANTITY_WORD_TOKENS.has(token)
    || RU_QUANTITY_MORPHOLOGY_PATTERNS.some((pattern) => pattern.test(token));
}

function containsSensitiveMarker(value) {
  if (/\p{N}|\p{Sc}/u.test(value)
      || /\b(?:https?:\/\/|www\.)\S+/iu.test(value)
      || /\b\S+@\S+\b/u.test(value)
      || /(?<![\p{L}\p{N}_])@[\p{L}\p{N}_.-]+/u.test(value)
      || /\b(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?:\/\S*)?/iu.test(value)
      || /\b[\p{L}\p{N}]+_[\p{L}\p{N}_]+\b/u.test(value)) {
    return true;
  }

  const tokens = value.match(/[\p{L}]+/gu) ?? [];
  return tokens.some((token) => token.length > 20
    || isCurrencyAlias(token)
    || isSensitiveQuantityToken(token));
}

function detectSourceLanguage(value) {
  const sanitized = String(value ?? "")
    .normalize("NFKC")
    .replaceAll(/\b(?:https?:\/\/|www\.)\S+/giu, " ")
    .replaceAll(/\b\S+@\S+\b/gu, " ")
    .replaceAll(/(?<![\p{L}\p{N}_])@[\p{L}\p{N}_.-]+/gu, " ")
    .replaceAll(/\b(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?:\/\S*)?/giu, " ");
  const hasRu = /\p{Script=Cyrillic}/u.test(sanitized);
  const hasEn = /\p{Script=Latin}/u.test(sanitized);
  if (hasRu && hasEn) return "mixed";
  if (hasRu) return "ru";
  if (hasEn) return "en";
  return "unknown";
}

function normalizeDraftStatus(value) {
  const status = String(value ?? "").toLowerCase();
  return ["pending", "confirmed", "inbox", "cancelled"].includes(status)
    ? status
    : "unknown";
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
