import { inferCategory, inferTags } from "./categories.js";
import { toOffsetIso } from "./time.js";

const CURRENCY_ALIASES = new Map([
  ["бат", "THB"],
  ["бата", "THB"],
  ["батов", "THB"],
  ["thb", "THB"],
  ["руб", "RUB"],
  ["рублей", "RUB"],
  ["rub", "RUB"],
  ["доллар", "USD"],
  ["долларов", "USD"],
  ["usd", "USD"]
]);

export function parseExpenseText(text, options = {}) {
  const now = options.now ?? new Date();
  const parts = text
    .split(/[,;\n]+|\s+и\s+/iu)
    .map((part) => part.trim())
    .filter(Boolean);

  const expenses = parts.flatMap((part) => parsePart(part, now));
  return {
    expenses,
    notes: expenses.length === 0 ? ["Не удалось найти сумму расхода."] : []
  };
}

function parsePart(part, now) {
  const match = part.match(/(?<amount>\d+(?:[.,]\d{1,2})?)\s*(?<currency>[A-Za-zА-Яа-я]+)?/u);
  if (!match?.groups) return [];

  const amount = Number(match.groups.amount.replace(",", "."));
  const rawCurrency = match.groups.currency?.toLowerCase();
  const currency = rawCurrency ? CURRENCY_ALIASES.get(rawCurrency) ?? "THB" : "THB";
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
    spent_at: toOffsetIso(now),
    confidence: needsReview ? 0.62 : 0.86,
    needs_review: needsReview
  }];
}
