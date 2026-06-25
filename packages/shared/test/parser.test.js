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
