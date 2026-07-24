import test from "node:test";
import assert from "node:assert/strict";

import {
  NEEDS_ATTENTION_MAX_SHOWN,
  categoryChanges,
  categoryPercentages,
  largestExpenses,
  needsAttentionFromUnpaid,
  weeklyComparison,
  weeklyTakeaway
} from "../src/reportAnalytics.js";

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

test("weeklyTakeaway attributes a rise to a dominant single expense and notes flat everyday spending", () => {
  const takeaway = weeklyTakeaway({
    comparable: true,
    currentTotal: 8713,
    priorTotal: 3800,
    largestExpense: { name: "Аренда квартиры", amount: 5000 },
    changes: [],
    language: "ru"
  });
  assert.match(takeaway, /главным образом из-за «Аренда квартиры»/);
  assert.match(takeaway, /примерно на уровне прошлой недели/);
});

test("weeklyTakeaway notes a dominant expense when everyday spending did not stay flat", () => {
  const takeaway = weeklyTakeaway({
    comparable: true,
    currentTotal: 8713,
    priorTotal: 7400,
    largestExpense: { name: "Rent", amount: 5000 },
    changes: [],
    language: "en"
  });
  assert.match(takeaway, /More than half of this week's spending went to Rent/);
});

test("weeklyTakeaway attributes a rise to the leading category change", () => {
  const takeaway = weeklyTakeaway({
    comparable: true,
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

test("weeklyTakeaway is hidden when no defensible cause exists", () => {
  const takeaway = weeklyTakeaway({
    comparable: true,
    currentTotal: 8713,
    priorTotal: 8500,
    largestExpense: { name: "Coffee", amount: 200 },
    changes: [{ name: "Food", direction: "up", delta: 100, percentDelta: 5 }],
    language: "ru"
  });
  assert.equal(takeaway, null);
});
