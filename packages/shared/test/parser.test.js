import test from "node:test";
import assert from "node:assert/strict";

import { parseExpenseText } from "../src/parser.js";

test("parses a simple Russian text expense into a draft item", () => {
  const result = parseExpenseText("кофе 70 бат", {
    now: new Date("2026-06-01T10:00:00+07:00")
  });

  assert.equal(result.expenses.length, 1);
  assert.deepEqual(result.expenses[0], {
    amount: 70,
    currency: "THB",
    description: "кофе",
    category_slug: "food_cafe",
    category_source: "parser",
    tags: [],
    spent_at: "2026-06-01T10:00:00.000+07:00",
    confidence: 0.86,
    needs_review: false
  });
  assert.deepEqual(result.notes, []);
});

test("uses THB when currency is omitted", () => {
  const result = parseExpenseText("обед 180", {
    now: new Date("2026-06-01T12:30:00+07:00")
  });

  assert.equal(result.expenses[0].currency, "THB");
  assert.equal(result.expenses[0].amount, 180);
});

test("uses provided default currency when currency is omitted", () => {
  const result = parseExpenseText("coffee 14000", {
    defaultCurrency: "IDR",
    now: new Date("2026-06-01T12:30:00+07:00")
  });

  assert.equal(result.expenses[0].currency, "IDR");
  assert.equal(result.expenses[0].amount, 14000);
});

test("formats parsed timestamps in the supplied timezone", () => {
  const result = parseExpenseText("coffee 70", {
    now: new Date("2026-06-01T03:30:00Z"),
    timeZone: "America/New_York"
  });

  assert.equal(result.expenses[0].spent_at, "2026-05-31T23:30:00.000-04:00");
});

test("parses compact thousands notation", () => {
  const compact = parseExpenseText("coffee 14k", { defaultCurrency: "IDR" });
  const compactCyrillic = parseExpenseText("coffee 14к", { defaultCurrency: "IDR" });
  const spaced = parseExpenseText("coffee 14 000", { defaultCurrency: "IDR" });

  assert.equal(compact.expenses[0].amount, 14000);
  assert.equal(compactCyrillic.expenses[0].amount, 14000);
  assert.equal(spaced.expenses[0].amount, 14000);
});

test("marks explicitly large one-off expenses as non-daily impact", () => {
  const result = parseExpenseText("крупная разовая покупка продукты 2000 бат", {
    now: new Date("2026-06-06T10:00:00+07:00")
  });

  assert.equal(result.expenses[0].amount, 2000);
  assert.equal(result.expenses[0].category_slug, "groceries");
  assert.equal(result.expenses[0].budget_impact, "large_oneoff");
});

test("parses added currency aliases and education category", () => {
  const result = parseExpenseText("English 1000 евро");

  assert.equal(result.expenses[0].currency, "EUR");
  assert.equal(result.expenses[0].category_slug, "education");
});

test("parses amount before English description", () => {
  const result = parseExpenseText("120 grab", {
    now: new Date("2026-06-01T12:30:00+07:00")
  });

  assert.equal(result.expenses.length, 1);
  assert.equal(result.expenses[0].amount, 120);
  assert.equal(result.expenses[0].description, "grab");
  assert.equal(result.expenses[0].category_slug, "transport");
});

test("parses English relative dates and category keywords", () => {
  const result = parseExpenseText("yesterday groceries 900", {
    now: new Date("2026-06-03T12:00:00+07:00")
  });

  assert.equal(result.expenses.length, 1);
  assert.equal(result.expenses[0].spent_at.slice(0, 10), "2026-06-02");
  assert.equal(result.expenses[0].category_slug, "groceries");
});

test("parses attached currency symbols deterministically", () => {
  const examples = [
    ["coffee $50", 50, "USD"],
    ["coffee 50฿", 50, "THB"],
    ["coffee 120₽", 120, "RUB"],
    ["coffee 20€", 20, "EUR"],
    ["coffee 30₾", 30, "GEL"]
  ];

  for (const [text, amount, currency] of examples) {
    const result = parseExpenseText(text);
    assert.equal(result.expenses[0].amount, amount, text);
    assert.equal(result.expenses[0].currency, currency, text);
  }
});

test("rejects ambiguous amount formats locally", () => {
  const result = parseExpenseText("coffee 1,200");

  assert.equal(result.expenses.length, 0);
});

test("rejects small leading bare integer that could be quantity", () => {
  const result = parseExpenseText("2 coffee");
  const russian = parseExpenseText("2 кофе");

  assert.equal(result.expenses.length, 0);
  assert.equal(russian.expenses.length, 0);
});

test("parses small trailing bare integer as amount after description", () => {
  const english = parseExpenseText("coffee 8");
  const russian = parseExpenseText("чай 8");

  assert.equal(english.expenses.length, 1);
  assert.equal(english.expenses[0].amount, 8);
  assert.equal(russian.expenses.length, 1);
  assert.equal(russian.expenses[0].amount, 8);
  assert.equal(russian.expenses[0].category_slug, "other");
});

test("parses clean English multi-expense split", () => {
  const result = parseExpenseText("taxi 120, coffee 80");

  assert.equal(result.expenses.length, 2);
  assert.deepEqual(result.expenses.map((expense) => expense.amount), [120, 80]);
  assert.deepEqual(result.expenses.map((expense) => expense.category_slug), ["transport", "food_cafe"]);
});

test("applies relative dates per expense segment", () => {
  const result = parseExpenseText("вчера кофе 200 бат, сегодня шоколадка 100 бат", {
    now: new Date("2026-06-03T12:00:00+07:00")
  });

  assert.equal(result.expenses.length, 2);
  assert.equal(result.expenses[0].spent_at.slice(0, 10), "2026-06-02");
  assert.equal(result.expenses[1].spent_at.slice(0, 10), "2026-06-03");
});

test("marks the category as parser-provided", () => {
  const result = parseExpenseText("coffee 80", {
    now: new Date("2026-06-01T10:00:00+07:00")
  });

  assert.equal(result.expenses[0].category_source, "parser");
});
