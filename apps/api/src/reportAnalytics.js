import { categoryLabel } from "../../../packages/shared/src/categories.js";

export const COMPARISON_FLAT_PERCENT = 5;
export const CHANGE_RELATIVE_MIN = 0.25;
export const CHANGE_ABSOLUTE_BY_CURRENCY = { THB: 1000, RUB: 2500, USD: 30, EUR: 30 };
export const CHANGE_ABSOLUTE_DEFAULT = 30;
export const TAKEAWAY_DOMINANT_EXPENSE_SHARE = 0.5;
export const TAKEAWAY_FLAT_BAND = 0.15;
export const TAKEAWAY_CATEGORY_SHARE_OF_DELTA = 0.6;
export const NEEDS_ATTENTION_MAX_SHOWN = 3;

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
  return [...expenses]
    .map((expense) => ({
      name: String(expense.description ?? "").trim() || categoryLabel(expense.category_slug, language),
      amount: num(expense.amount_base ?? expense.amount)
    }))
    .filter((item) => item.amount > 0)
    .sort((left, right) => right.amount - left.amount)
    .slice(0, limit);
}

export function categoryPercentages(rawCategories = [], totalSpent = 0, { language = "ru", limit = 3 } = {}) {
  const total = num(totalSpent);
  const items = [...rawCategories]
    .map((category) => ({ slug: slugOf(category), amount: amountOf(category) }))
    .filter((category) => category.amount > 0)
    .sort((left, right) => right.amount - left.amount)
    .slice(0, limit)
    .map((category) => ({
      name: categoryLabel(category.slug, language),
      amount: category.amount,
      percent: total > 0 ? Math.round((category.amount / total) * 100) : 0
    }));
  const topTwo = items.slice(0, 2);
  const topTwoShare = topTwo.length >= 2 ? topTwo.reduce((sum, item) => sum + item.percent, 0) : null;
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

export function categoryChanges({ current = [], prior = [], language = "ru", currency = "THB" } = {}) {
  const priorBySlug = new Map(prior.map((category) => [slugOf(category), amountOf(category)]));
  const absoluteMin = CHANGE_ABSOLUTE_BY_CURRENCY[String(currency || "").toUpperCase()] ?? CHANGE_ABSOLUTE_DEFAULT;

  return current
    .map((category) => {
      const slug = slugOf(category);
      const currentTotal = amountOf(category);
      const priorTotal = priorBySlug.get(slug) ?? 0;
      const delta = currentTotal - priorTotal;
      const isNew = priorTotal <= 0 && currentTotal > 0;
      const passesAbsolute = Math.abs(delta) >= absoluteMin;
      const passesRelative = isNew
        ? currentTotal >= absoluteMin
        : priorTotal > 0 && Math.abs(delta) / priorTotal >= CHANGE_RELATIVE_MIN;
      if (!passesAbsolute || !passesRelative) return null;
      return {
        slug,
        name: categoryLabel(slug, language),
        direction: delta > 0 ? "up" : "down",
        delta,
        percentDelta: priorTotal > 0 ? Math.round((delta / priorTotal) * 100) : null,
        currentTotal,
        priorTotal,
        isNew
      };
    })
    .filter(Boolean)
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

export function weeklyTakeaway({
  comparable = false,
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

  if (dominant && delta > 0) {
    const name = dominant.name;
    const excluding = current - dominantAmount;
    const stayedFlat = prior > 0 && Math.abs(excluding - prior) / prior <= TAKEAWAY_FLAT_BAND;
    if (stayedFlat) {
      return en
        ? `Spending rose mainly because of ${name}. Excluding it, everyday spending stayed close to the previous week.`
        : `Расходы выросли главным образом из-за «${name}». Без этой траты повседневные расходы остались примерно на уровне прошлой недели.`;
    }
    return en
      ? `More than half of this week's spending went to ${name}.`
      : `Больше половины расходов недели пришлось на «${name}».`;
  }

  const totalAbsDelta = Math.abs(delta);
  const attribution = totalAbsDelta > 0
    ? changes.find((change) => Math.abs(change.delta) >= TAKEAWAY_CATEGORY_SHARE_OF_DELTA * totalAbsDelta) ?? null
    : null;
  if (attribution) {
    if (attribution.direction === "up") {
      return en
        ? `Spending rose mainly because of ${attribution.name}.`
        : `Расходы выросли главным образом за счёт «${attribution.name}».`;
    }
    return en
      ? `Spending fell mainly because of ${attribution.name}.`
      : `Расходы снизились главным образом за счёт «${attribution.name}».`;
  }

  return null;
}
