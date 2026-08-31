import test from "node:test";
import assert from "node:assert/strict";

import { currencyLabel, currencyOptions } from "../src/currencies.js";

test("currency labels include a flag, code and native fallback text", () => {
  assert.match(currencyLabel("THB"), /^🇹🇭 THB — Thai Baht \/ /);
  assert.match(currencyLabel("USD"), /^🇺🇸 USD — US Dollar \/ /);
  assert.match(currencyLabel("INR"), /^🇮🇳 INR — Indian Rupee \/ /);
});

test("currency options render one native label per value", () => {
  const html = currencyOptions("THB", (value, selected, label) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`);

  assert.match(html, /value="THB" selected>🇹🇭 THB — Thai Baht \/ /);
  assert.match(html, /value="USD">🇺🇸 USD — US Dollar \/ /);
  assert.match(html, /value="INR">🇮🇳 INR — Indian Rupee \/ /);
});

test("currency options filter by code and translated name while retaining the selected value", () => {
  const option = (value, selected, label) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`;

  assert.match(currencyOptions("THB", option, "indian"), /value="INR"/);
  assert.match(currencyOptions("THB", option, "indian"), /value="THB" selected/);
  assert.doesNotMatch(currencyOptions("THB", option, "indian"), /value="GEL"/);
});
