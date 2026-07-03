import { inferCategory, inferTags } from "./categories.js";
import { normalizeCurrency } from "./currencies.js";
import { toZonedIso } from "./time.js";

const DEFAULT_MAX_LOCAL_AMOUNT = 1_000_000;

const CURRENCY_ALIASES = new Map([
  ["baht", "THB"],
  ["бат", "THB"],
  ["бата", "THB"],
  ["батов", "THB"],
  ["บาท", "THB"],
  ["thb", "THB"],
  ["฿", "THB"],
  ["usd", "USD"],
  ["$", "USD"],
  ["dollar", "USD"],
  ["dollars", "USD"],
  ["доллар", "USD"],
  ["долларов", "USD"],
  ["бакс", "USD"],
  ["rub", "RUB"],
  ["руб", "RUB"],
  ["рубль", "RUB"],
  ["рублей", "RUB"],
  ["₽", "RUB"],
  ["eur", "EUR"],
  ["euro", "EUR"],
  ["euros", "EUR"],
  ["евро", "EUR"],
  ["€", "EUR"],
  ["idr", "IDR"],
  ["rupiah", "IDR"],
  ["рупия", "IDR"],
  ["рупий", "IDR"],
  ["byn", "BYN"],
  ["бел.руб", "BYN"],
  ["gel", "GEL"],
  ["лари", "GEL"],
  ["₾", "GEL"]
]);

const SYMBOL_CURRENCIES = new Set(["$", "฿", "₽", "€", "₾"]);
const DATE_WORDS = [
  "сегодня",
  "вчера",
  "позавчера",
  "утром",
  "днем",
  "днём",
  "вечером",
  "ночью",
  "today",
  "yesterday",
  "day before yesterday"
];

export function parseExpenseText(text, options = {}) {
  const now = options.now ?? new Date();
  const defaultCurrency = normalizeCurrency(options.defaultCurrency, "THB");
  const timeZone = options.timeZone ?? "Asia/Bangkok";
  const maxLocalAmount = normalizeMaxLocalAmount(options.maxLocalAmount);
  if (hasUnsafeAmountSyntax(text)) {
    return {
      expenses: [],
      notes: ["Не удалось безопасно разобрать сумму расхода."]
    };
  }
  const parts = splitExpenseParts(text);

  const expenses = [];
  for (const part of parts) {
    const parsed = parsePart(part, now, defaultCurrency, timeZone, maxLocalAmount);
    if (!parsed) {
      return {
        expenses: [],
        notes: ["Не удалось безопасно разобрать сумму расхода."]
      };
    }
    expenses.push(parsed);
  }

  return {
    expenses,
    notes: expenses.length === 0 ? ["Не удалось найти сумму расхода."] : []
  };
}

function splitExpenseParts(text) {
  return String(text ?? "")
    .split(/[,;\n]+|\s+и\s+|\s+and\s+/iu)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parsePart(part, now, defaultCurrency, timeZone, maxLocalAmount) {
  if (hasUnsafeAmountSyntax(part)) return null;

  const amountMatches = findAmountMatches(part);
  if (amountMatches.length !== 1) return null;

  const amountMatch = amountMatches[0];
  if (amountMatch.invalid) return null;
  const amount = normalizeAmount(amountMatch.rawAmount, amountMatch.multiplier);
  if (!Number.isFinite(amount) || amount <= 0 || amount > maxLocalAmount) return null;

  const currency = resolveCurrency(part, amountMatch, defaultCurrency);
  if (!currency) return null;

  if (isSmallBareIntegerWithoutCurrency(part, amountMatch)) return null;

  const spentAt = resolveRelativeDate(part, now);
  const budgetImpact = detectBudgetImpact(part);
  const description = cleanDescription(
    `${part.slice(0, amountMatch.start)} ${part.slice(amountMatch.end)}`
  ) || "расход";
  const category = inferCategory(description);
  const needsReview = category === "other";

  const expense = {
    amount,
    currency,
    description,
    category_slug: category,
    category_source: "parser",
    tags: inferTags(description),
    spent_at: toZonedIso(spentAt, timeZone),
    confidence: needsReview ? 0.62 : 0.86,
    needs_review: needsReview
  };
  if (budgetImpact !== "regular") expense.budget_impact = budgetImpact;
  return expense;
}

function findAmountMatches(part) {
  const matches = [];
  const pattern = /([$฿₽€₾])?\s*(\d[\d\s\u00a0.,]*)([kк])?\s*([$฿₽€₾])?/giu;
  for (const match of part.matchAll(pattern)) {
    const rawAmount = match[2].trim();
    if (!rawAmount || !amountShapeIsSupported(rawAmount)) {
      return [{ invalid: true }];
    }
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      rawAmount,
      multiplier: match[3],
      leadingSymbol: match[1],
      trailingSymbol: match[4]
    });
  }
  return matches;
}

function amountShapeIsSupported(value) {
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return true;
  if (/^\d{1,3}(?:[\s\u00a0]\d{3})+$/.test(text)) return true;
  if (/^\d{1,3}\.\d{3}$/.test(text)) return true;
  if (/^\d+\.\d{1,2}$/.test(text)) return !/^\d{1,3}\.\d{3}$/.test(text);
  if (/^\d+,\d{1,2}$/.test(text)) return true;
  return false;
}

function normalizeAmount(value, multiplier) {
  const text = String(value).trim();
  let numericText;
  if (/^\d{1,3}(?:[\s\u00a0]\d{3})+$/.test(text)) {
    numericText = text.replaceAll(/[\s\u00a0]/g, "");
  } else if (/^\d{1,3}\.\d{3}$/.test(text)) {
    numericText = text.replace(".", "");
  } else {
    numericText = text.replace(",", ".");
  }
  const numeric = Number(numericText);
  return multiplier ? numeric * 1000 : numeric;
}

function normalizeMaxLocalAmount(value) {
  const number = Number(value ?? DEFAULT_MAX_LOCAL_AMOUNT);
  return Number.isFinite(number) && number > 0 ? number : DEFAULT_MAX_LOCAL_AMOUNT;
}

function hasUnsafeAmountSyntax(part) {
  return /\d+\s*[+xх]\s*\d+/iu.test(part)
    || /\d+\s+(?:за|for)\s+\d+/iu.test(part)
    || /\d+[,]\d{3}(?!\d)/u.test(part)
    || /\d+[.,]\d+[.,]\d+/u.test(part);
}

function resolveCurrency(part, amountMatch, defaultCurrency) {
  const candidates = [];
  for (const symbol of [amountMatch.leadingSymbol, amountMatch.trailingSymbol].filter(Boolean)) {
    candidates.push(CURRENCY_ALIASES.get(symbol));
  }

  const before = part.slice(0, amountMatch.start).trim().split(/\s+/u).at(-1);
  const after = part.slice(amountMatch.end).trim().split(/\s+/u)[0];
  for (const token of [before, after].filter(Boolean)) {
    const normalized = normalizeCurrencyToken(token);
    if (CURRENCY_ALIASES.has(normalized)) {
      candidates.push(CURRENCY_ALIASES.get(normalized));
    }
  }

  const unique = [...new Set(candidates.filter(Boolean))];
  if (unique.length > 1) return null;
  return unique[0] ?? defaultCurrency;
}

function normalizeCurrencyToken(token) {
  return String(token ?? "").toLowerCase().replaceAll("ё", "е").replace(/[.,;:!?]+$/u, "");
}

function isSmallBareIntegerWithoutCurrency(part, amountMatch) {
  if (amountMatch.leadingSymbol || amountMatch.trailingSymbol) return false;
  if (!/^\d+$/.test(amountMatch.rawAmount)) return false;
  const amount = Number(amountMatch.rawAmount);
  if (!Number.isInteger(amount) || amount >= 10) return false;
  return part.slice(0, amountMatch.start).trim() === ""
    && cleanDescription(part.slice(amountMatch.end)) !== "";
}

function cleanDescription(value) {
  let text = String(value ?? "").toLowerCase().replaceAll("ё", "е");
  for (const word of DATE_WORDS) {
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, "giu"), " ");
  }
  for (const token of CURRENCY_ALIASES.keys()) {
    if (SYMBOL_CURRENCIES.has(token)) continue;
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(token)}(?![\\p{L}\\p{N}])`, "giu"), " ");
  }
  return text
    .replace(/\b(large|big)\s+one[-\s]?off\s+(purchase|expense)?\b/giu, " ")
    .replace(/\b(крупн(?:ая|ую|ое|ый)|больш(?:ая|ую|ое|ой))\s+разов(?:ая|ую|ое|ой)?\s+(покупк[аиу]?|трат[ау])?\b/giu, " ")
    .replace(/\bразов(?:ая|ую|ое|ой)\s+(крупн(?:ая|ую|ое|ый)|больш(?:ая|ую|ое|ой))\s+(покупк[аиу]?|трат[ау])?\b/giu, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function detectBudgetImpact(part) {
  return /(крупн(?:ая|ую|ое|ый)|больш(?:ая|ую|ое|ой))\s+разов(?:ая|ую|ое|ой)?(?:\s+(покупк[аиу]?|трат[ау]))?/iu.test(part)
    || /разов(?:ая|ую|ое|ой)\s+(крупн(?:ая|ую|ое|ый)|больш(?:ая|ую|ое|ой))(?:\s+(покупк[аиу]?|трат[ау]))?/iu.test(part)
    || /\b(large|big)\s+one[-\s]?off\s+(purchase|expense)?\b/iu.test(part)
    ? "large_oneoff"
    : "regular";
}

function resolveRelativeDate(part, now) {
  const lowered = String(part ?? "").toLowerCase().replaceAll("ё", "е");
  const daysOffset = /(?<![\p{L}\p{N}])(позавчера|day before yesterday)(?![\p{L}\p{N}])/iu.test(lowered)
    ? -2
    : /(?<![\p{L}\p{N}])(вчера|yesterday)(?![\p{L}\p{N}])/iu.test(lowered)
      ? -1
      : 0;
  if (!daysOffset) return now;
  return new Date(now.getTime() + daysOffset * 24 * 60 * 60_000);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
