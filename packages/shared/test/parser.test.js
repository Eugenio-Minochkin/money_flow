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

test("uses one million as the default maximum local amount", () => {
  const atLimit = parseExpenseText("laptop 1000000");
  const aboveLimit = parseExpenseText("laptop 1000001");

  assert.equal(atLimit.expenses.length, 1);
  assert.equal(atLimit.expenses[0].amount, 1_000_000);
  assert.equal(aboveLimit.expenses.length, 0);
});

test("allows caller to override the maximum local amount", () => {
  const result = parseExpenseText("laptop 1000001", { maxLocalAmount: 2_000_000 });

  assert.equal(result.expenses.length, 1);
  assert.equal(result.expenses[0].amount, 1_000_001);
});

test("preserves accepted Russian parser regressions", () => {
  const examples = [
    ["купил кофе за 80 бат", [80]],
    ["потратил на кофе 80", [80]],
    ["кофе на 80 бат", [80]],
    ["запиши кофе 80", [80]],
    ["купил два кофе за 80", [80]],
    ["два кофе 160", [160]],
    ["кофе 80 и молоко 100", [80, 100]]
  ];

  for (const [text, amounts] of examples) {
    const result = parseExpenseText(text);
    assert.deepEqual(result.expenses.map((expense) => expense.amount), amounts, text);
    assert.deepEqual(result.notes, [], text);
  }
});

test("merges ASR punctuation when the next part starts with an amount", () => {
  const digit = parseExpenseText("кофе, 80 бат");
  const command = parseExpenseText("Запиши кофе, 80 бат.");
  const multi = parseExpenseText("кофе 80, молоко 100");

  assert.equal(digit.expenses.length, 1);
  assert.equal(digit.expenses[0].amount, 80);
  assert.equal(digit.expenses[0].currency, "THB");
  assert.equal(command.expenses.length, 1);
  assert.equal(command.expenses[0].amount, 80);
  assert.deepEqual(multi.expenses.map((expense) => expense.amount), [80, 100]);
});

test("parses Russian amount words only when they look like an amount", () => {
  const examples = [
    ["молоко сто бат", 100, "THB"],
    ["кофе восемьдесят бат", 80, "THB"],
    ["обед двести пятьдесят бат", 250, "THB"],
    ["такси триста бат", 300, "THB"],
    ["продукты одна тысяча двести бат", 1200, "THB"],
    ["еда две тысячи триста пятьдесят бат", 2350, "THB"],
    ["купил кофе за восемьдесят бат", 80, "THB"],
    ["Молоко, сто бат", 100, "THB"]
  ];

  for (const [text, amount, currency] of examples) {
    const result = parseExpenseText(text);
    assert.equal(result.expenses.length, 1, text);
    assert.equal(result.expenses[0].amount, amount, text);
    assert.equal(result.expenses[0].currency, currency, text);
  }
});

test("does not turn Russian quantity words or invalid number grammar into amounts", () => {
  const quantity = parseExpenseText("два кофе");
  const invalidRepeated = parseExpenseText("сто сто бат");
  const outOfRange = parseExpenseText("десять тысяч бат");
  const embeddedWord = parseExpenseText("стоянка 200");

  assert.equal(quantity.expenses.length, 0);
  assert.equal(invalidRepeated.expenses.length, 0);
  assert.equal(outOfRange.expenses.length, 0);
  assert.equal(embeddedWord.expenses.length, 1);
  assert.equal(embeddedWord.expenses[0].amount, 200);
  assert.equal(embeddedWord.expenses[0].description, "стоянка");
});

test("cleans Russian filler words dangling prepositions and added currency aliases", () => {
  const coffee = parseExpenseText("купил кофе за 80 бат");
  const spentCoffee = parseExpenseText("потратил на кофе 80");
  const ticket = parseExpenseText("билет на самолет 3000");
  const bahtTypo = parseExpenseText("кофе 80 бахт");
  const rub = parseExpenseText("такси 200 рубля");
  const usd = parseExpenseText("обед 10 доллара");

  assert.equal(coffee.expenses[0].description, "кофе");
  assert.equal(spentCoffee.expenses[0].description, "кофе");
  assert.equal(ticket.expenses[0].description, "билет на самолет");
  assert.equal(bahtTypo.expenses[0].currency, "THB");
  assert.equal(bahtTypo.expenses[0].description, "кофе");
  assert.equal(rub.expenses[0].currency, "RUB");
  assert.equal(usd.expenses[0].currency, "USD");
});

test("does not add a Cyrillic category bypass outside the category model", () => {
  const phone = parseExpenseText("купил телефон 10000");
  const movieTicket = parseExpenseText("билет в кино 300");

  assert.notEqual(phone.expenses[0].category_slug, "subscriptions");
  assert.equal(movieTicket.expenses[0].category_slug, "entertainment");
});

test("preserves English parser regressions and ASR punctuation", () => {
  const examples = [
    ["coffee 80", 80, "coffee"],
    ["coffee 80 baht", 80, "coffee"],
    ["coffee for 80 baht", 80, "coffee"],
    ["spent 80 baht on coffee", 80, "coffee"],
    ["add coffee 80", 80, "coffee"],
    ["milk 120 baht", 120, "milk"],
    ["lunch 250 baht", 250, "lunch"],
    ["taxi 300 baht", 300, "taxi"],
    ["coffee, 80 baht", 80, "coffee"],
    ["Add coffee, 80 baht.", 80, "coffee"],
    ["milk, 120 baht", 120, "milk"],
    ["bought coffee for 80 baht", 80, "coffee"],
    ["paid for internet 600", 600, "internet"]
  ];

  for (const [text, amount, description] of examples) {
    const result = parseExpenseText(text);
    assert.equal(result.expenses.length, 1, text);
    assert.equal(result.expenses[0].amount, amount, text);
    assert.equal(result.expenses[0].description, description, text);
  }

  const multi = parseExpenseText("coffee 80, milk 100");
  assert.deepEqual(multi.expenses.map((expense) => expense.amount), [80, 100]);
});

test("English description cleanup keeps meaningful internal prepositions", () => {
  const result = parseExpenseText("ticket to Bangkok 500");

  assert.equal(result.expenses[0].description, "ticket to bangkok");
});
