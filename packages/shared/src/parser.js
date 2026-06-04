import { inferCategory, inferTags } from "./categories.js";
import { normalizeCurrency } from "./currencies.js";
import { toOffsetIso } from "./time.js";

const CURRENCY_ALIASES = new Map([
  ["бат", "THB"],
  ["бата", "THB"],
  ["батов", "THB"],
  ["thb", "THB"],
  ["руб", "RUB"],
  ["рублей", "RUB"],
  ["рубль", "RUB"],
  ["rub", "RUB"],
  ["доллар", "USD"],
  ["долларов", "USD"],
  ["usd", "USD"],
  ["рупий", "IDR"],
  ["рупия", "IDR"],
  ["idr", "IDR"],
  ["евро", "EUR"],
  ["eur", "EUR"],
  ["byn", "BYN"],
  ["белруб", "BYN"],
  ["лари", "GEL"],
  ["gel", "GEL"]
]);

export function parseExpenseText(text, options = {}) {
  const now = options.now ?? new Date();
  const defaultCurrency = normalizeCurrency(options.defaultCurrency, "THB");
  const parts = text
    .split(/[,;\n]+|\s+и\s+/iu)
    .map((part) => part.trim())
    .filter(Boolean);

  const expenses = parts.flatMap((part) => parsePart(part, now, defaultCurrency));
  return {
    expenses,
    notes: expenses.length === 0 ? ["Не удалось найти сумму расхода."] : []
  };
}

function parsePart(part, now, defaultCurrency) {
  const match = part.match(/(?<amount>\d+(?:[\s\u00a0]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?<multiplier>[kк])?\s*(?<currency>[A-Za-zА-Яа-я]+)?/u);
  if (!match?.groups) return [];

  const amount = normalizeAmount(match.groups.amount, match.groups.multiplier);
  const rawCurrency = match.groups.currency?.toLowerCase();
  const currency = rawCurrency ? normalizeCurrency(CURRENCY_ALIASES.get(rawCurrency), defaultCurrency) : defaultCurrency;
  const spentAt = resolveRelativeDate(part, now);
  const description = part
    .slice(0, match.index)
    .replace(/\b(сегодня|вчера|позавчера|утром|днем|днём|вечером|ночью)\b/giu, "")
    .trim()
    || "расход";
  const category = inferCategory(description);
  const needsReview = category === "other";

  return [{
    amount,
    currency,
    description,
    category_slug: category,
    tags: inferTags(description),
    spent_at: toOffsetIso(spentAt),
    confidence: needsReview ? 0.62 : 0.86,
    needs_review: needsReview
  }];
}

function normalizeAmount(value, multiplier) {
  const numeric = Number(String(value).replace(/[\s\u00a0]/g, "").replace(",", "."));
  return multiplier ? numeric * 1000 : numeric;
}

function resolveRelativeDate(part, now) {
  const lowered = part.toLowerCase();
  const daysOffset = lowered.includes("позавчера") ? -2 : lowered.includes("вчера") ? -1 : 0;
  if (!daysOffset) return now;
  return new Date(now.getTime() + daysOffset * 24 * 60 * 60_000);
}
