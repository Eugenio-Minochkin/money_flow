import test from "node:test";
import assert from "node:assert/strict";

import { currencyLabel, currencyOptions } from "../src/currencies.js";

test("currency labels do not include emoji flags", () => {
  assert.equal(currencyLabel("THB"), "THB - Thai baht");
  assert.equal(currencyLabel("USD"), "USD - US dollar");
});

test("currency options render labels without regional-letter emoji", () => {
  const html = currencyOptions("THB", (value, selected, label) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`);

  assert.match(html, />THB - Thai baht</);
  assert.doesNotMatch(html, /[\u{1F1E6}-\u{1F1FF}]/u);
});
