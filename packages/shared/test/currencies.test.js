import test from "node:test";
import assert from "node:assert/strict";

import {
  currencyFlag,
  currencyLabel,
  currencySearchText,
  isSupportedCurrency,
  normalizeCurrency,
  SUPPORTED_CURRENCIES
} from "../src/currencies.js";

const REQUIRED_TRAVEL_CURRENCIES = [
  "USD", "EUR", "GBP", "CHF", "RUB", "BYN", "UAH", "GEL", "AMD", "AZN", "TRY",
  "THB", "VND", "KHR", "LAK", "MMK", "IDR", "MYR", "SGD", "PHP", "BND",
  "INR", "NPR", "LKR", "PKR", "BDT", "CNY", "HKD", "MOP", "TWD", "JPY", "KRW",
  "AED", "SAR", "QAR", "OMR", "BHD", "KWD", "JOD", "ILS", "AUD", "NZD", "CAD",
  "MXN", "BRL", "ARS", "CLP", "COP", "PEN", "UYU", "PYG", "BOB", "ZAR", "MAD",
  "EGP", "KES", "TZS", "UGX", "PLN", "CZK", "HUF", "RON", "BGN", "RSD", "ALL",
  "BAM", "MKD", "ISK", "NOK", "SEK", "DKK"
];

test("catalogue contains unique active travel fiat metadata", () => {
  assert.ok(SUPPORTED_CURRENCIES.length >= 100);
  assert.equal(new Set(SUPPORTED_CURRENCIES.map((currency) => currency.code)).size, SUPPORTED_CURRENCIES.length);
  for (const code of REQUIRED_TRAVEL_CURRENCIES) assert.equal(isSupportedCurrency(code), true, code);
  for (const currency of SUPPORTED_CURRENCIES) {
    assert.match(currency.code, /^[A-Z]{3}$/u);
    assert.equal(typeof currency.name.en, "string");
    assert.equal(typeof currency.name.ru, "string");
    assert.ok(currencySearchText(currency.code).includes(currency.code.toLowerCase()));
  }
});

test("preserves permissive normalization and exposes strict membership", () => {
  assert.equal(currencyFlag("IDR"), "🇮🇩");
  assert.equal(currencyLabel("EUR"), "🇪🇺 EUR");
  assert.equal(normalizeCurrency("inr", "THB"), "INR");
  assert.equal(normalizeCurrency("unknown", "THB"), "THB");
  assert.equal(isSupportedCurrency("unknown"), false);
});
