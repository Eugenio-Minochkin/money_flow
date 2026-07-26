import test from "node:test";
import assert from "node:assert/strict";

import { SUPPORTED_CURRENCY_CODES } from "../../../packages/shared/src/currencies.js";
import {
  CHANGE_ABSOLUTE_BY_CURRENCY,
  MONTHLY_CHANGE_ABSOLUTE_TOTAL_SHARE,
  MONTHLY_CHANGE_RELATIVE_MIN,
  NEEDS_ATTENTION_MAX_SHOWN,
  categoryChanges,
  categoryPercentages,
  findDominantAttribution,
  largestExpenses,
  monthlyTakeaway,
  needsAttentionFromUnpaid,
  weeklyComparison,
  weeklyTakeaway
} from "../src/reportAnalytics.js";

test("every supported base currency has an explicit positive change threshold", () => {
  assert.ok(SUPPORTED_CURRENCY_CODES.length > 0, "expected supported currencies to be defined");
  for (const code of SUPPORTED_CURRENCY_CODES) {
    const threshold = CHANGE_ABSOLUTE_BY_CURRENCY[code];
    assert.ok(
      Number.isFinite(threshold) && threshold > 0,
      `currency ${code} must have an explicit positive absolute threshold (got ${threshold})`
    );
  }
  // High-magnitude currencies must not silently fall back to the tiny default.
  assert.ok(CHANGE_ABSOLUTE_BY_CURRENCY.IDR > 100_000, "IDR threshold must reflect its magnitude");
});

test("largestExpenses sorts by amount desc, caps at limit, and falls back to localized category", () => {
  const result = largestExpenses(
    [
      { description: "Кофе", category_slug: "food_cafe", amount_base: 120 },
      { description: "", category_slug: "home", amount_base: 9000 },
      { description: "Психолог", category_slug: "health", amount_base: 2500 }
    ],
    { language: "en", limit: 2 }
  );

  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { name: "Home", amount: 9000 });
  assert.deepEqual(result[1], { name: "Психолог", amount: 2500 });
});

test("largestExpenses ignores zero/negative amounts", () => {
  const result = largestExpenses(
    [
      { description: "A", category_slug: "other", amount_base: 0 },
      { description: "B", category_slug: "other", amount_base: -5 },
      { description: "C", category_slug: "other", amount_base: 10 }
    ],
    { language: "ru" }
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "C");
});

test("categoryPercentages computes rounded percents and top-two share", () => {
  const { items, topTwoShare } = categoryPercentages(
    [
      { category_slug: "gifts_help", total: 2839 },
      { category_slug: "food_cafe", total: 2611 },
      { category_slug: "home", total: 1492 }
    ],
    8713,
    { language: "ru", limit: 3 }
  );

  assert.equal(items[0].name, "Подарки / помощь");
  assert.equal(items[0].percent, 33);
  assert.equal(items[1].percent, 30);
  assert.equal(items[2].percent, 17);
  assert.equal(topTwoShare, 63);
});

test("categoryPercentages hides top-two share when fewer than two categories", () => {
  const { topTwoShare } = categoryPercentages([{ category_slug: "home", total: 1000 }], 1000);
  assert.equal(topTwoShare, null);
});

test("weeklyComparison is unavailable when the prior week had no spending", () => {
  assert.equal(weeklyComparison({ currentTotal: 1000, priorTotal: 0 }).available, false);
  assert.equal(weeklyComparison({ currentTotal: 1000 }).available, false);
});

test("weeklyComparison classifies up, down and flat", () => {
  assert.deepEqual(weeklyComparison({ currentTotal: 1180, priorTotal: 1000 }), {
    available: true, direction: "up", percentDelta: 18, currentTotal: 1180, priorTotal: 1000, delta: 180
  });
  assert.equal(weeklyComparison({ currentTotal: 900, priorTotal: 1000 }).direction, "down");
  assert.equal(weeklyComparison({ currentTotal: 1010, priorTotal: 1000 }).direction, "flat");
});

test("categoryChanges hides noisy small-amount changes even with a high percentage", () => {
  const changes = categoryChanges({
    current: [{ category_slug: "food_cafe", total: 100 }],
    prior: [{ category_slug: "food_cafe", total: 50 }],
    language: "en",
    currency: "THB"
  });
  assert.deepEqual(changes, []);
});

test("categoryChanges shows a change only when both absolute and relative thresholds pass", () => {
  const changes = categoryChanges({
    current: [{ category_slug: "gifts_help", total: 2600 }],
    prior: [{ category_slug: "gifts_help", total: 1400 }],
    language: "en",
    currency: "THB"
  });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].direction, "up");
  assert.equal(changes[0].delta, 1200);
  assert.equal(changes[0].percentDelta, 86);
  assert.equal(changes[0].name, "Gifts & Help");

  const hidden = categoryChanges({
    current: [{ category_slug: "food_cafe", total: 1250 }],
    prior: [{ category_slug: "food_cafe", total: 1000 }],
    language: "en",
    currency: "THB"
  });
  assert.deepEqual(hidden, []);
});

test("categoryChanges surfaces a meaningful brand-new category", () => {
  const changes = categoryChanges({
    current: [{ category_slug: "gifts_help", total: 1500 }],
    prior: [],
    language: "ru",
    currency: "THB"
  });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].isNew, true);
  assert.equal(changes[0].direction, "up");
});

test("categoryChanges is capped at three and sorted by absolute delta", () => {
  const changes = categoryChanges({
    current: [
      { category_slug: "home", total: 5000 },
      { category_slug: "gifts_help", total: 3000 },
      { category_slug: "food_cafe", total: 2000 },
      { category_slug: "travel", total: 1800 }
    ],
    prior: [
      { category_slug: "home", total: 2000 },
      { category_slug: "gifts_help", total: 1000 },
      { category_slug: "food_cafe", total: 500 },
      { category_slug: "travel", total: 500 }
    ],
    language: "en",
    currency: "THB"
  });
  assert.equal(changes.length, 3);
  assert.deepEqual(changes.map((c) => c.slug), ["home", "gifts_help", "food_cafe"]);
});

test("categoryChanges uses the full category set, so a category ranked below top five is not treated as new", () => {
  const changes = categoryChanges({
    current: [{ category_slug: "entertainment", total: 2000 }],
    prior: [{ category_slug: "entertainment", total: 500 }],
    language: "en",
    currency: "THB"
  });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].isNew, false);
  assert.equal(changes[0].direction, "up");
});

test("categoryChanges reports a category that dropped to zero as a decrease", () => {
  const changes = categoryChanges({
    current: [],
    prior: [{ category_slug: "travel", total: 2000 }],
    language: "en",
    currency: "THB"
  });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].slug, "travel");
  assert.equal(changes[0].direction, "down");
  assert.equal(changes[0].currentTotal, 0);
  assert.equal(changes[0].priorTotal, 2000);
  assert.equal(changes[0].percentDelta, -100);
});

test("categoryPercentages computes the top-two share from raw amounts, not summed rounded percents", () => {
  const { items, topTwoShare } = categoryPercentages(
    [
      { category_slug: "home", total: 1 },
      { category_slug: "food_cafe", total: 1 },
      { category_slug: "travel", total: 1 }
    ],
    3,
    { language: "en", limit: 3 }
  );
  assert.deepEqual(items.map((item) => item.percent), [33, 33, 33]);
  assert.equal(topTwoShare, 67);
});

test("needsAttentionFromUnpaid prioritizes overdue items and collapses the rest", () => {
  const { total, shown, moreCount, count } = needsAttentionFromUnpaid([
    { name: "internet", amount: 700, dueDate: "2026-07-16", overdue: false },
    { name: "english", amount: 1000, dueDate: "2026-06-30", overdue: true },
    { name: "gym", amount: 500, dueDate: "2026-07-17", overdue: false },
    { name: "spa", amount: 800, dueDate: "2026-07-18", overdue: false },
    { name: "extra", amount: 300, dueDate: "2026-07-19", overdue: false }
  ]);
  assert.equal(count, 5);
  assert.equal(total, 3300);
  assert.equal(shown.length, NEEDS_ATTENTION_MAX_SHOWN);
  assert.equal(shown[0].name, "english");
  assert.equal(moreCount, 2);
});

test("weeklyTakeaway returns null when not comparable", () => {
  assert.equal(weeklyTakeaway({ comparable: false }), null);
});

test("weeklyTakeaway attributes a rise to a dominant single expense", () => {
  const takeaway = weeklyTakeaway({
    comparable: true,
    comparisonDirection: "up",
    currentTotal: 8713,
    priorTotal: 3800,
    largestExpense: { name: "Аренда квартиры", amount: 5000 },
    changes: [],
    language: "ru"
  });
  assert.equal(takeaway, "Больше половины расходов недели пришлось на операцию «Аренда квартиры».");
});

test("weeklyTakeaway dominant-expense line states the share, not an unproven cause of the change", () => {
  // The largest operation is more than half of THIS week, but prior week had a comparable
  // large operation too — so it cannot be proven as the cause of the rise. The takeaway must
  // only report the share, never causal wording like "рост ... связан с".
  const takeaway = weeklyTakeaway({
    comparable: true,
    comparisonDirection: "up",
    currentTotal: 9000,
    priorTotal: 8800,
    largestExpense: { name: "Аренда квартиры", amount: 5000 },
    changes: [],
    language: "ru"
  });
  assert.equal(takeaway, "Больше половины расходов недели пришлось на операцию «Аренда квартиры».");
  assert.doesNotMatch(takeaway, /связан|из-за|причиной|вызвал/);
});

test("weeklyTakeaway notes a dominant expense in English without claiming a decline", () => {
  const takeaway = weeklyTakeaway({
    comparable: true,
    comparisonDirection: "up",
    currentTotal: 8713,
    priorTotal: 7400,
    largestExpense: { name: "Rent", amount: 5000 },
    changes: [],
    language: "en"
  });
  assert.match(takeaway, /More than half of this week's spending went to Rent/);
});

test("weeklyTakeaway attributes a rise to the leading up category change", () => {
  const takeaway = weeklyTakeaway({
    comparable: true,
    comparisonDirection: "up",
    currentTotal: 8713,
    priorTotal: 7400,
    largestExpense: { name: "Coffee", amount: 200 },
    changes: [
      { name: "Gifts & Help", direction: "up", delta: 1200, percentDelta: 86 }
    ],
    language: "en"
  });
  assert.match(takeaway, /Spending rose mainly because of Gifts & Help/);
});

test("weeklyTakeaway attributes a decline to the leading down category change", () => {
  const takeaway = weeklyTakeaway({
    comparable: true,
    comparisonDirection: "down",
    currentTotal: 5000,
    priorTotal: 8000,
    largestExpense: { name: "Coffee", amount: 200 },
    changes: [
      { name: "Travel", direction: "down", delta: -3000, percentDelta: -60 }
    ],
    language: "ru"
  });
  assert.equal(takeaway, "Основное снижение пришлось на категорию «Travel».");
});

test("weeklyTakeaway is hidden when no defensible cause exists", () => {
  const takeaway = weeklyTakeaway({
    comparable: true,
    comparisonDirection: "up",
    currentTotal: 8713,
    priorTotal: 8500,
    largestExpense: { name: "Coffee", amount: 200 },
    changes: [{ name: "Food", direction: "up", delta: 100, percentDelta: 5 }],
    language: "ru"
  });
  assert.equal(takeaway, null);
});

test("weeklyTakeaway does not attribute an overall rise to a negative category change", () => {
  const takeaway = weeklyTakeaway({
    comparable: true,
    comparisonDirection: "up",
    currentTotal: 9000,
    priorTotal: 8000,
    largestExpense: { name: "Coffee", amount: 200 },
    changes: [{ name: "Food", direction: "down", delta: -2000, percentDelta: -40 }],
    language: "ru"
  });
  assert.equal(takeaway, null);
});

test("weeklyTakeaway does not name a positive change as the cause of an overall decline", () => {
  const takeaway = weeklyTakeaway({
    comparable: true,
    comparisonDirection: "down",
    currentTotal: 7000,
    priorTotal: 9000,
    largestExpense: { name: "Coffee", amount: 200 },
    changes: [{ name: "Food", direction: "up", delta: 2000, percentDelta: 40 }],
    language: "en"
  });
  assert.equal(takeaway, null);
});

test("weeklyTakeaway produces no growth or decline wording on a flat comparison", () => {
  const takeaway = weeklyTakeaway({
    comparable: true,
    comparisonDirection: "flat",
    currentTotal: 8000,
    priorTotal: 7900,
    largestExpense: { name: "Rent", amount: 5000 },
    changes: [
      { name: "Food", direction: "up", delta: 2000, percentDelta: 40 },
      { name: "Travel", direction: "down", delta: -1900, percentDelta: -38 }
    ],
    language: "ru"
  });
  assert.equal(takeaway, null);
});

// --- Monthly change thresholds ---

test("categoryChanges defaults keep the weekly thresholds when no monthly options are passed", () => {
  // 14% relative, 250 THB absolute -> hidden under weekly rules too (absolute floor 1000 THB).
  const changes = categoryChanges({
    current: [{ category_slug: "food_cafe", total: 1140 }],
    prior: [{ category_slug: "food_cafe", total: 1000 }],
    language: "en",
    currency: "THB"
  });
  assert.deepEqual(changes, []);
});

test("monthly categoryChanges uses 20% relative and a scaled absolute threshold", () => {
  // Dom: +3200 on ~46500 base. relative 3200/11700 ≈ 27% >= 20%; absolute >= max(1000, 5%*46500=2325). Passes.
  const changes = categoryChanges({
    current: [{ category_slug: "home", total: 14920 }],
    prior: [{ category_slug: "home", total: 11720 }],
    language: "ru",
    currency: "THB",
    relativeMin: MONTHLY_CHANGE_RELATIVE_MIN,
    absoluteFloor: MONTHLY_CHANGE_ABSOLUTE_TOTAL_SHARE * 46500
  });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].slug, "home");
  assert.equal(changes[0].delta, 3200);

  // 14% relative noise on a small base -> hidden (relative fails).
  const noise = categoryChanges({
    current: [{ category_slug: "food_cafe", total: 1140 }],
    prior: [{ category_slug: "food_cafe", total: 1000 }],
    language: "ru",
    currency: "THB",
    relativeMin: MONTHLY_CHANGE_RELATIVE_MIN,
    absoluteFloor: MONTHLY_CHANGE_ABSOLUTE_TOTAL_SHARE * 1140
  });
  assert.deepEqual(noise, []);
});

test("monthly categoryChanges never falls below the currency floor even for tiny totals", () => {
  const changes = categoryChanges({
    current: [{ category_slug: "home", total: 60 }],
    prior: [{ category_slug: "home", total: 30 }],
    language: "en",
    currency: "THB",
    relativeMin: MONTHLY_CHANGE_RELATIVE_MIN,
    absoluteFloor: MONTHLY_CHANGE_ABSOLUTE_TOTAL_SHARE * 60
  });
  assert.deepEqual(changes, []);
});

// --- largestExpenses stable tie-break ---

test("largestExpenses breaks amount ties by earlier date then id", () => {
  const result = largestExpenses(
    [
      { id: "3", description: "later", category_slug: "other", amount_base: 2000, local_date: "2026-06-20" },
      { id: "1", description: "earlier", category_slug: "other", amount_base: 2000, local_date: "2026-06-05" },
      { id: "2", description: "biggest", category_slug: "other", amount_base: 5000, local_date: "2026-06-10" }
    ],
    { language: "en", limit: 3 }
  );
  assert.deepEqual(result, [
    { name: "biggest", amount: 5000 },
    { name: "earlier", amount: 2000 },
    { name: "later", amount: 2000 }
  ]);
});

test("largestExpenses breaks id ties numerically, not lexicographically", () => {
  const result = largestExpenses(
    [
      { id: "10", description: "ten", category_slug: "other", amount_base: 2000, local_date: "2026-06-05" },
      { id: "2", description: "two", category_slug: "other", amount_base: 2000, local_date: "2026-06-05" }
    ],
    { language: "en", limit: 2 }
  );
  assert.deepEqual(result, [
    { name: "two", amount: 2000 },
    { name: "ten", amount: 2000 }
  ]);
});

// --- findDominantAttribution ---

test("findDominantAttribution requires direction match and >= 60% of the delta", () => {
  const change = { name: "Home", direction: "up", delta: 3200 };
  assert.equal(findDominantAttribution([change], "up", 5000)?.name, "Home");
  assert.equal(findDominantAttribution([change], "up", 6000), null);
  assert.equal(findDominantAttribution([change], "down", 5000), null);
  assert.equal(findDominantAttribution([change], "flat", 5000), null);
});

// --- monthlyTakeaway ---

const monthlyMoney = (value) => `${Math.round(Number(value ?? 0))} THB`;

test("monthlyTakeaway notes high budget usage and concentration together", () => {
  const takeaway = monthlyTakeaway({
    comparable: true,
    comparisonDirection: "up",
    currentTotal: 49765,
    priorTotal: 44000,
    budget: { available: true, usedPercent: 98, overAmount: 0 },
    topTwoShare: 56,
    largestExpense: { name: "Оплата квартиры", amount: 13000 },
    changes: [],
    language: "ru",
    formatMoney: monthlyMoney
  });
  assert.equal(
    takeaway,
    "Вы уложились в бюджет, но использовали 98% доступной суммы. Две главные категории составили 56% расходов месяца."
  );
});

test("monthlyTakeaway states the exceeded amount as a fact", () => {
  const takeaway = monthlyTakeaway({
    comparable: false,
    comparisonDirection: "flat",
    currentTotal: 54200,
    priorTotal: 0,
    budget: { available: true, usedPercent: 108, overAmount: 4200 },
    topTwoShare: 40,
    largestExpense: { name: "Rent", amount: 4000 },
    changes: [],
    language: "en",
    formatMoney: monthlyMoney
  });
  assert.equal(takeaway, "The budget was exceeded by 4200 THB.");
});

test("monthlyTakeaway attributes a rise to a direction-consistent category", () => {
  const takeaway = monthlyTakeaway({
    comparable: true,
    comparisonDirection: "up",
    currentTotal: 12000,
    priorTotal: 8000,
    budget: { available: true, usedPercent: 50, overAmount: 0 },
    topTwoShare: 30,
    largestExpense: { name: "Coffee", amount: 200 },
    changes: [{ name: "Travel", direction: "up", delta: 3500 }],
    language: "ru",
    formatMoney: monthlyMoney
  });
  assert.equal(takeaway, "Основной рост пришёлся на категорию «Travel».");
});

test("monthlyTakeaway describes a dominant single operation as a share, not a cause", () => {
  const takeaway = monthlyTakeaway({
    comparable: true,
    comparisonDirection: "up",
    currentTotal: 10000,
    priorTotal: 9800,
    budget: { available: true, usedPercent: 40, overAmount: 0 },
    topTwoShare: 35,
    largestExpense: { name: "Оплата квартиры", amount: 4000 },
    changes: [],
    language: "ru",
    formatMoney: monthlyMoney
  });
  assert.equal(takeaway, "Больше четверти расходов месяца пришлось на операцию «Оплата квартиры».");
  assert.doesNotMatch(takeaway, /из-за|связан|причиной|вызвал/);
});

test("monthlyTakeaway does not claim 'more than a quarter' at exactly 25%", () => {
  const exact = monthlyTakeaway({
    comparable: false,
    comparisonDirection: "flat",
    currentTotal: 10000,
    priorTotal: 0,
    budget: { available: true, usedPercent: 40, overAmount: 0 },
    topTwoShare: 30,
    largestExpense: { name: "Rent", amount: 2500 },
    changes: [],
    language: "ru",
    formatMoney: monthlyMoney
  });
  assert.equal(exact, null);

  const above = monthlyTakeaway({
    comparable: false,
    comparisonDirection: "flat",
    currentTotal: 10000,
    priorTotal: 0,
    budget: { available: true, usedPercent: 40, overAmount: 0 },
    topTwoShare: 30,
    largestExpense: { name: "Rent", amount: 2501 },
    changes: [],
    language: "ru",
    formatMoney: monthlyMoney
  });
  assert.match(above, /Больше четверти/);
});

test("monthlyTakeaway is hidden on a flat comparison with no defensible fact", () => {
  const takeaway = monthlyTakeaway({
    comparable: true,
    comparisonDirection: "flat",
    currentTotal: 10000,
    priorTotal: 9800,
    budget: { available: true, usedPercent: 40, overAmount: 0 },
    topTwoShare: 35,
    largestExpense: { name: "Coffee", amount: 200 },
    changes: [{ name: "Food", direction: "up", delta: 200 }],
    language: "ru",
    formatMoney: monthlyMoney
  });
  assert.equal(takeaway, null);
});

test("monthlyTakeaway is hidden when not comparable and no budget/concentration fact", () => {
  const takeaway = monthlyTakeaway({
    comparable: false,
    comparisonDirection: "flat",
    currentTotal: 3000,
    priorTotal: 0,
    budget: { available: true, usedPercent: 30, overAmount: 0 },
    topTwoShare: 40,
    largestExpense: { name: "Coffee", amount: 200 },
    changes: [],
    language: "en",
    formatMoney: monthlyMoney
  });
  assert.equal(takeaway, null);
});

test("monthlyTakeaway does not attribute an overall rise to a declining category", () => {
  const takeaway = monthlyTakeaway({
    comparable: true,
    comparisonDirection: "up",
    currentTotal: 12000,
    priorTotal: 8000,
    budget: null,
    topTwoShare: 30,
    largestExpense: { name: "Coffee", amount: 200 },
    changes: [{ name: "Food", direction: "down", delta: -3500 }],
    language: "en",
    formatMoney: monthlyMoney
  });
  assert.equal(takeaway, null);
});
