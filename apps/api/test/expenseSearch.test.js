import test from "node:test";
import assert from "node:assert/strict";

import { matchesExpenseSearch, parseAmountSearch } from "../src/expenseSearch.js";

const expense = {
  amount_original: 2200,
  currency_original: "RUB",
  amount_base: 950,
  base_currency: "THB",
  display: { amount: 26.65, currency: "USD" },
  description: "Coffee beans",
  category_slug: "groceries",
  tags: ["home"]
};

test("parseAmountSearch normalizes spaces, NBSP, decimal comma and currency forms", () => {
  assert.deepEqual(parseAmountSearch("2 200 RUB"), { amount: 2200, currency: "RUB" });
  assert.deepEqual(parseAmountSearch("2\u00a0200"), { amount: 2200, currency: null });
  assert.deepEqual(parseAmountSearch("$26,65"), { amount: 26.65, currency: "USD" });
  assert.deepEqual(parseAmountSearch("~$26.65"), { amount: 26.65, currency: "USD" });
  assert.deepEqual(parseAmountSearch("26,65$"), { amount: 26.65, currency: "USD" });
  assert.deepEqual(parseAmountSearch("RUB 2 200"), { amount: 2200, currency: "RUB" });
  assert.deepEqual(parseAmountSearch("26.65 USD"), { amount: 26.65, currency: "USD" });
  assert.equal(parseAmountSearch("coffee 2200"), null);
});

test("matchesExpenseSearch compares zero-decimal display currencies as rendered", () => {
  assert.equal(matchesExpenseSearch({
    ...expense,
    display: { amount: 950.49, currency: "THB" }
  }, "950 THB"), true);
  assert.equal(matchesExpenseSearch({
    ...expense,
    display: { amount: 950.51, currency: "THB" }
  }, "951"), true);
});

test("matchesExpenseSearch finds original, base and current display amounts at two decimals", () => {
  for (const query of ["2200", "2 200", "2200 RUB", "950", "950 THB", "26.65", "26,65", "$26.65"]) {
    assert.equal(matchesExpenseSearch(expense, query), true, query);
  }
  assert.equal(matchesExpenseSearch(expense, "2200 USD"), false);
  assert.equal(matchesExpenseSearch(expense, "26.66"), false);
});

test("matchesExpenseSearch preserves description, category and tag matching", () => {
  assert.equal(matchesExpenseSearch(expense, "coffee"), true);
  assert.equal(matchesExpenseSearch(expense, "grocer"), true);
  assert.equal(matchesExpenseSearch(expense, "HOME"), true);
  assert.equal(matchesExpenseSearch(expense, "transport"), false);
});
