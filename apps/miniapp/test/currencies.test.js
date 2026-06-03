import test from "node:test";
import assert from "node:assert/strict";

import { currencyLabel, currencyOptions } from "../src/currencies.js";

test("currency labels use readable flag badges instead of emoji flags", () => {
  assert.equal(currencyLabel("THB"), "[TH] THB - Thai baht");
  assert.equal(currencyLabel("USD"), "[US] USD - US dollar");
});

test("currency options render readable labels", () => {
  const html = currencyOptions("THB", (value, selected, label) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`);

  assert.match(html, /\[TH\] THB - Thai baht/);
  assert.doesNotMatch(html, /🇹🇭/);
});
