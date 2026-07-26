import { categoryLabel } from "../../../packages/shared/src/categories.js";
import { SUPPORTED_CURRENCY_CODES } from "../../../packages/shared/src/currencies.js";

export const COMPARISON_FLAT_PERCENT = 5;
export const CHANGE_RELATIVE_MIN = 0.25;
export const CHANGE_ABSOLUTE_BY_CURRENCY = {
  THB: 1000,
  RUB: 2500,
  USD: 30,
  EUR: 30,
  IDR: 500_000,
  BYN: 100,
  GEL: 80
};
export const CHANGE_ABSOLUTE_DEFAULT = 30;
export const TAKEAWAY_DOMINANT_EXPENSE_SHARE = 0.5;
export const TAKEAWAY_CATEGORY_SHARE_OF_DELTA = 0.6;
export const NEEDS_ATTENTION_MAX_SHOWN = 3;

export const MONTHLY_CHANGE_RELATIVE_MIN = 0.20;
export const MONTHLY_CHANGE_ABSOLUTE_TOTAL_SHARE = 0.05;
export const MONTHLY_TAKEAWAY_DOMINANT_EXPENSE_SHARE = 0.25;
export const MONTHLY_TAKEAWAY_CONCENTRATION_MIN = 50;
export const MONTHLY_BUDGET_HIGH_USAGE_MIN_PCT = 90;
export const MONTHLY_BUDGET_EXCEEDED_PCT = 100;

function num(value) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

function slugOf(category) {
  return category.category_slug ?? category.slug;
}

function amountOf(category) {
  return num(category.total ?? category.amount ?? category.amount_base);
}

export function largestExpenses(expenses = [], { language = "ru", limit = 5 } = {}) {
  const ranked = [...expenses]
    .map((expense) => ({
      name: String(expense.description ?? "").trim() || categoryLabel(expense.category_slug, language),
      amount: num(expense.amount_base ?? expense.amount),
      date: String(expense.local_date ?? expense.date ?? ""),
      id: String(expense.id ?? "")
    }))
    .filter((item) => item.amount > 0)
    .sort((left, right) =>
      right.amount - left.amount
      || left.date.localeCompare(right.date)
      || left.id.localeCompare(right.id));
  return ranked.slice(0, limit).map(({ name, amount }) => ({ name, amount }));
}

export function categoryPercentages(rawCategories = [], totalSpent = 0, { language = "ru", limit = 3 } = {}) {
  const total = num(totalSpent);
  const sorted = [...rawCategories]
    .map((category) => ({ slug: slugOf(category), amount: amountOf(category) }))
    .filter((category) => category.amount > 0)
    .sort((left, right) => right.amount - left.amount);
  const items = sorted.slice(0, limit).map((category) => ({
    name: categoryLabel(category.slug, language),
    amount: category.amount,
    percent: total > 0 ? Math.round((category.amount / total) * 100) : 0
  }));
  const topTwo = sorted.slice(0, 2);
  const topTwoShare = topTwo.length >= 2 && total > 0
    ? Math.round(((topTwo[0].amount + topTwo[1].amount) / total) * 100)
    : null;
  return { items, topTwoShare };
}

export function weeklyComparison({ currentTotal = 0, priorTotal = 0 } = {}) {
  const current = num(currentTotal);
  const prior = num(priorTotal);
  if (!(prior > 0)) return { available: false };
  const delta = current - prior;
  const percentDelta = Math.round((delta / prior) * 100);
  const direction = Math.abs(percentDelta) <= COMPARISON_FLAT_PERCENT ? "flat" : delta > 0 ? "up" : "down";
  return { available: true, direction, percentDelta, currentTotal: current, priorTotal: prior, delta };
}

export function categoryChanges({
  current = [],
  prior = [],
  language = "ru",
  currency = "THB",
  relativeMin = CHANGE_RELATIVE_MIN,
  absoluteFloor = null
} = {}) {
  const currentMap = new Map(current.map((category) => [slugOf(category), amountOf(category)]));
  const priorMap = new Map(prior.map((category) => [slugOf(category), amountOf(category)]));
  const floor = CHANGE_ABSOLUTE_BY_CURRENCY[String(currency || "").toUpperCase()] ?? CHANGE_ABSOLUTE_DEFAULT;
  const absoluteMin = absoluteFloor != null ? Math.max(floor, absoluteFloor) : floor;
  const relativeThreshold = Number(relativeMin) > 0 ? Number(relativeMin) : CHANGE_RELATIVE_MIN;
  const slugs = new Set([...currentMap.keys(), ...priorMap.keys()]);
  const changes = [];
  for (const slug of slugs) {
    const currentTotal = currentMap.get(slug) ?? 0;
    const priorTotal = priorMap.get(slug) ?? 0;
    const delta = currentTotal - priorTotal;
    if (delta === 0) continue;
    const isNew = priorTotal <= 0 && currentTotal > 0;
    const passesAbsolute = Math.abs(delta) >= absoluteMin;
    const passesRelative = isNew
      ? currentTotal >= absoluteMin
      : priorTotal > 0 && Math.abs(delta) / priorTotal >= relativeThreshold;
    if (!passesAbsolute || !passesRelative) continue;
    changes.push({
      slug,
      name: categoryLabel(slug, language),
      direction: delta > 0 ? "up" : "down",
      delta,
      percentDelta: priorTotal > 0 ? Math.round((delta / priorTotal) * 100) : null,
      currentTotal,
      priorTotal,
      isNew
    });
  }
  return changes
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, 3);
}

export function needsAttentionFromUnpaid(unpaidItems = []) {
  const items = [...unpaidItems].sort((left, right) => {
    if (!!left.overdue !== !!right.overdue) return left.overdue ? -1 : 1;
    return String(left.dueDate ?? "").localeCompare(String(right.dueDate ?? ""));
  });
  const shown = items.slice(0, NEEDS_ATTENTION_MAX_SHOWN);
  const total = items.reduce((sum, item) => sum + num(item.amount), 0);
  const moreCount = Math.max(items.length - shown.length, 0);
  return { total, shown, moreCount, count: items.length };
}

export function findDominantAttribution(changes = [], comparisonDirection, totalAbsDelta) {
  if (comparisonDirection === "flat" || !(Number(totalAbsDelta) > 0)) return null;
  return changes.find(
    (change) => change.direction === comparisonDirection
      && Math.abs(change.delta) >= TAKEAWAY_CATEGORY_SHARE_OF_DELTA * Number(totalAbsDelta)
  ) ?? null;
}

export function weeklyTakeaway({
  comparable = false,
  comparisonDirection = "flat",
  currentTotal = 0,
  priorTotal = 0,
  largestExpense = null,
  changes = [],
  language = "ru"
} = {}) {
  if (!comparable) return null;
  const current = num(currentTotal);
  const prior = num(priorTotal);
  const delta = current - prior;
  const en = language === "en";

  const dominantAmount = largestExpense ? num(largestExpense.amount) : 0;
  const dominant = current > 0 && dominantAmount >= TAKEAWAY_DOMINANT_EXPENSE_SHARE * current ? largestExpense : null;
  if (dominant && comparisonDirection === "up") {
    const name = dominant.name;
    return en
      ? `More than half of this week's spending went to ${name}.`
      : `Больше половины расходов недели пришлось на операцию «${name}».`;
  }

  const attribution = findDominantAttribution(changes, comparisonDirection, Math.abs(delta));
  if (attribution) {
    if (attribution.direction === "up") {
      return en
        ? `Spending rose mainly because of ${attribution.name}.`
        : `Основной рост пришёлся на категорию «${attribution.name}».`;
    }
    return en
      ? `Spending fell mainly because of ${attribution.name}.`
      : `Основное снижение пришлось на категорию «${attribution.name}».`;
  }

  return null;
}

export function monthlyTakeaway({
  comparable = false,
  comparisonDirection = "flat",
  currentTotal = 0,
  priorTotal = 0,
  budget = null,
  topTwoShare = null,
  largestExpense = null,
  changes = [],
  language = "ru",
  formatMoney = (value) => String(Math.round(Number(value ?? 0)))
} = {}) {
  const en = language === "en";
  const current = num(currentTotal);
  const prior = num(priorTotal);
  const sentences = [];

  if (budget && budget.available) {
    const usedPct = Number.isFinite(Number(budget.usedPercent)) ? Math.round(Number(budget.usedPercent)) : null;
    const overAmount = num(budget.overAmount);
    if (overAmount > 0) {
      const money = formatMoney(overAmount);
      sentences.push(en ? `The budget was exceeded by ${money}.` : `Бюджет был превышен на ${money}.`);
    } else if (usedPct != null && usedPct >= MONTHLY_BUDGET_HIGH_USAGE_MIN_PCT && usedPct <= MONTHLY_BUDGET_EXCEEDED_PCT) {
      sentences.push(en
        ? `You stayed within budget but used ${usedPct}% of the available amount.`
        : `Вы уложились в бюджет, но использовали ${usedPct}% доступной суммы.`);
    }
  }

  const secondary = [];
  if (topTwoShare != null && Number(topTwoShare) >= MONTHLY_TAKEAWAY_CONCENTRATION_MIN) {
    secondary.push(en
      ? `The top two categories accounted for ${topTwoShare}% of this month's spending.`
      : `Две главные категории составили ${topTwoShare}% расходов месяца.`);
  }
  if (comparable) {
    const attribution = findDominantAttribution(changes, comparisonDirection, Math.abs(current - prior));
    if (attribution) {
      secondary.push(attribution.direction === "up"
        ? (en ? `Most of the increase came from ${attribution.name}.` : `Основной рост пришёлся на категорию «${attribution.name}».`)
        : (en ? `Most of the decrease came from ${attribution.name}.` : `Основное снижение пришлось на категорию «${attribution.name}».`));
    }
  }
  const dominantAmount = largestExpense ? num(largestExpense.amount) : 0;
  if (current > 0 && dominantAmount >= MONTHLY_TAKEAWAY_DOMINANT_EXPENSE_SHARE * current) {
    const name = largestExpense.name;
    secondary.push(en
      ? `More than a quarter of this month's spending went to ${name}.`
      : `Больше четверти расходов месяца пришлось на операцию «${name}».`);
  }

  const ordered = [...sentences, ...secondary].slice(0, 2);
  return ordered.length > 0 ? ordered.join(" ") : null;
}
