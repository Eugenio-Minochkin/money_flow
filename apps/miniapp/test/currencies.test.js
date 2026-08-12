import test from "node:test";
import assert from "node:assert/strict";

import { currencyLabel, currencyOptions } from "../src/currencies.js";

test("currency labels include a flag, code and native fallback text", () => {
  assert.equal(currencyLabel("THB"), "🇹🇭 THB — Thai baht");
  assert.equal(currencyLabel("USD"), "🇺🇸 USD — US dollar");
});

test("currency options render one native label per value", () => {
  const html = currencyOptions("THB", (value, selected, label) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`);

  assert.match(html, />🇹🇭 THB — Thai baht</);
  assert.match(html, /value="USD">🇺🇸 USD — US dollar</);
});
