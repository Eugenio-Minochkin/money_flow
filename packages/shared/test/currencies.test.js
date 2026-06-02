import test from "node:test";
import assert from "node:assert/strict";

import { currencyFlag, currencyLabel, normalizeCurrency, SUPPORTED_CURRENCIES } from "../src/currencies.js";

test("supports the full MVP currency list with flags", () => {
  assert.deepEqual(SUPPORTED_CURRENCIES.map((currency) => currency.code), ["THB", "USD", "RUB", "IDR", "EUR", "BYN", "GEL"]);
  assert.equal(currencyFlag("IDR"), "🇮🇩");
  assert.equal(currencyLabel("EUR"), "🇪🇺 EUR");
  assert.equal(normalizeCurrency("gel", "THB"), "GEL");
  assert.equal(normalizeCurrency("unknown", "THB"), "THB");
});
