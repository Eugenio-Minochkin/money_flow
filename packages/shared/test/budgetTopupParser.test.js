import test from "node:test";
import assert from "node:assert/strict";
import { parseBudgetTopupText } from "../src/budgetTopupParser.js";

const now = new Date("2026-06-30T10:00:00.000Z");

const positiveCases = [
  ["добавь 5000 к бюджету", { amount: 5000, currency: "THB", kind: "other" }],
  ["добавь 5000 бат к бюджету", { amount: 5000, currency: "THB", kind: "other" }],
  ["пополни бюджет на 3000 бат", { amount: 3000, currency: "THB", kind: "other" }],
  ["пришло 5000", { amount: 5000, currency: "THB", kind: "other" }],
  ["пришло 5000 бат", { amount: 5000, currency: "THB", kind: "other" }],
  ["премия 10000", { amount: 10000, currency: "THB", kind: "income" }],
  ["вернули 800 за билеты", { amount: 800, currency: "THB", kind: "refund" }],
  ["получил 100 долларов", { amount: 100, currency: "USD", kind: "other" }],
  ["add 5000 to my budget", { amount: 5000, currency: "THB", kind: "other" }],
  ["top up my budget by 3000 baht", { amount: 3000, currency: "THB", kind: "other" }],
  ["increase my budget by 3000", { amount: 3000, currency: "THB", kind: "other" }],
  ["I got 5000 baht", { amount: 5000, currency: "THB", kind: "other" }],
  ["I received 5000 baht", { amount: 5000, currency: "THB", kind: "other" }],
  ["bonus 10000", { amount: 10000, currency: "THB", kind: "income" }],
  ["got paid 10000", { amount: 10000, currency: "THB", kind: "income" }],
  ["refund 800", { amount: 800, currency: "THB", kind: "refund" }],
  ["they returned 800 baht", { amount: 800, currency: "THB", kind: "refund" }],
  ["add $100 to this month's budget", { amount: 100, currency: "USD", kind: "other" }]
];

for (const [source, expected] of positiveCases) {
  test(`recognizes budget top-up: ${source}`, () => {
    const result = parseBudgetTopupText(source, {
      now,
      defaultCurrency: "THB",
      timeZone: "Asia/Bangkok"
    });

    assert.equal(result.state, "recognized");
    assert.equal(result.item.amount, expected.amount);
    assert.equal(result.item.currency, expected.currency);
    assert.equal(result.item.kind, expected.kind);
    assert.equal(result.item.month_key, "2026-06");
    assert.equal(result.item.local_date, "2026-06-30");
    assert.ok(result.item.occurred_at);
  });
}

const negativeCases = [
  "потратил 500 бат на еду",
  "купил кофе за 80",
  "заплатил 1200 за квартиру",
  "заплатил 5000",
  "пополнил счет на 5000",
  "закинул 5000 на карту",
  "перевел 10000 на накопительный",
  "перевел 10000 на карту",
  "снял 2000 со счета",
  "переложил 3000 в наличку",
  "spent 500 baht on food",
  "bought coffee for 80",
  "paid 1200 for rent",
  "paid 5000",
  "topped up my card by 5000",
  "transferred 10000 to my savings account",
  "moved 5000 between accounts",
  "withdrew 2000 from my account",
  "put 3000 on my card"
];

for (const source of negativeCases) {
  test(`does not recognize non-top-up: ${source}`, () => {
    const result = parseBudgetTopupText(source, { now, defaultCurrency: "THB", timeZone: "Asia/Bangkok" });
    assert.equal(result.state, "not_recognized");
  });
}

test("returns failed when top-up intent has no safe amount", () => {
  const result = parseBudgetTopupText("add something to my budget", { now, defaultCurrency: "THB", timeZone: "Asia/Bangkok" });
  assert.equal(result.state, "failed");
});

test("uses yesterday in the user's timezone", () => {
  const result = parseBudgetTopupText("I got 5000 yesterday", {
    now: new Date("2026-07-01T01:00:00.000+07:00"),
    defaultCurrency: "THB",
    timeZone: "Asia/Bangkok"
  });

  assert.equal(result.state, "recognized");
  assert.equal(result.item.local_date, "2026-06-30");
  assert.equal(result.item.month_key, "2026-06");
});
