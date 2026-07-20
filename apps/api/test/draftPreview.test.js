import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { hasMixedDraftCurrencies, renderDraftPreview } from "../src/draftPreview.js";

const mixedItems = [
  {
    amount: 10,
    currency: "usd",
    description: "coffee",
    category_slug: "food_cafe",
    spent_at: "2026-07-20T08:00:00.000Z",
    budget_impact: "regular"
  },
  {
    amount: 20,
    currency: "EUR",
    description: "lunch",
    category_slug: "food_cafe",
    spent_at: "2026-07-20T12:00:00.000Z",
    budget_impact: "regular"
  }
];

test("mixed draft currencies are normalized before comparison", () => {
  assert.equal(hasMixedDraftCurrencies(mixedItems), true);
  assert.equal(hasMixedDraftCurrencies([{ currency: "usd" }, { currency: "USD" }]), false);
  assert.equal(hasMixedDraftCurrencies([{ currency: undefined }, { currency: "THB" }]), false);
  assert.equal(hasMixedDraftCurrencies(), false);
});

test("mixed draft invokes repository preview once and renders its converted USD total", async () => {
  const calls = [];
  const repository = {
    async prepareDraftPreview(items, user) {
      calls.push({ items, user });
      return { kind: "converted", baseCurrency: "USD", total: 31.25 };
    }
  };
  const user = { id: 7, base_currency: "usd" };

  const text = await renderDraftPreview({
    repository,
    user,
    items: mixedItems,
    language: "en"
  });

  assert.deepEqual(calls, [{ items: mixedItems, user }]);
  assert.match(text, /<b>Total:<\/b> 31\.25 USD/);
  assert.doesNotMatch(text, /reliable total.*unavailable/i);
});

test("same-currency draft does not request repository conversion", async () => {
  const repository = {
    async prepareDraftPreview() {
      throw new Error("same-currency draft must not request conversion");
    }
  };
  const items = [
    { ...mixedItems[0], currency: "THB", amount: 100 },
    { ...mixedItems[1], currency: "THB", amount: 50 }
  ];

  const text = await renderDraftPreview({
    repository,
    user: { base_currency: "usd" },
    items,
    language: "en"
  });

  assert.match(text, /<b>Total:<\/b> 150 THB/);
});

test("same currency with different casing renders one normalized total without conversion", async () => {
  let repositoryCalls = 0;
  const items = [
    { ...mixedItems[0], currency: "usd", amount: 10 },
    { ...mixedItems[1], currency: "USD", amount: 20 }
  ];

  const text = await renderDraftPreview({
    repository: {
      async prepareDraftPreview() {
        repositoryCalls += 1;
        throw new Error("normalized same-currency draft must not request conversion");
      }
    },
    user: { base_currency: "USD" },
    items,
    language: "en"
  });

  assert.equal(repositoryCalls, 0);
  assert.match(text, /<b>Total:<\/b> 30\.00 USD/);
  assert.doesNotMatch(text, /10\.00 USD \+ 20\.00 USD/);
  assert.doesNotMatch(text, /reliable total.*unavailable/i);
});

test("missing draft currency defaults to THB consistently for detection and formatting", async () => {
  let repositoryCalls = 0;
  const items = [
    { ...mixedItems[0], currency: undefined, amount: 10 },
    { ...mixedItems[1], currency: "THB", amount: 20 }
  ];

  const text = await renderDraftPreview({
    repository: {
      async prepareDraftPreview() {
        repositoryCalls += 1;
        throw new Error("default-THB same-currency draft must not request conversion");
      }
    },
    user: { base_currency: "THB" },
    items,
    language: "en"
  });

  assert.equal(repositoryCalls, 0);
  assert.match(text, /<b>Total:<\/b> 30 THB/);
  assert.doesNotMatch(text, /10 THB \+ 20 THB/);
  assert.doesNotMatch(text, /reliable total.*unavailable/i);
});

test("unavailable mixed preview renders subtotals and warning without an aggregate", async () => {
  const repository = {
    async prepareDraftPreview() {
      return { kind: "unavailable", baseCurrency: "USD" };
    }
  };

  const text = await renderDraftPreview({
    repository,
    user: { base_currency: "usd" },
    items: mixedItems,
    language: "en"
  });

  assert.match(text, /10\.00 USD \+ 20\.00 EUR/);
  assert.match(text, /A reliable total in USD is unavailable/);
  assert.doesNotMatch(text, /<b>Total:<\/b> 30(?:\.00)? USD/);
});

test("draft preview module depends only on the pure Telegram formatter", async () => {
  const source = await readFile(new URL("../src/draftPreview.js", import.meta.url), "utf8");
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);

  assert.deepEqual(imports, ["./telegramFormat.js"]);
});
