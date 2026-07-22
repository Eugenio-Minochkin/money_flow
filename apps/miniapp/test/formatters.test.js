import test from "node:test";
import assert from "node:assert/strict";

import {
  dateTimeLocal,
  escapeAttribute,
  escapeHtml,
  formatMoney,
  formatDate,
  formatDateOnly,
  localDateKeyInTimeZone,
  moneyBase,
  moneyDisplay,
  moneyDisplaySigned
} from "../src/formatters.js";

test("formats base and display money", () => {
  assert.equal(normalizeSpaces(moneyBase(15269.99)), "15 270 THB");
  assert.equal(normalizeSpaces(moneyBase(14000, "IDR")), "14 000 IDR");
  assert.equal(moneyDisplay(69.44, "USD"), "~$69,44");
  assert.equal(normalizeSpaces(moneyDisplay(5000, "RUB")), "5 000 RUB");
  assert.equal(moneyDisplay(null, "USD"), "");
});

test("formats money with currency-specific display decimals", () => {
  assert.equal(normalizeSpaces(formatMoney(8720.81, "THB")), "8 721 THB");
  assert.equal(normalizeSpaces(formatMoney(12500.75, "RUB")), "12 501 RUB");
  assert.equal(normalizeSpaces(formatMoney(1500000.55, "IDR")), "1 500 001 IDR");
  assert.equal(normalizeSpaces(formatMoney(1234.56, "BYN")), "1 235 BYN");
  assert.equal(normalizeSpaces(formatMoney(266.58, "USD")), "266,58 USD");
  assert.equal(normalizeSpaces(formatMoney(45.2, "EUR")), "45,20 EUR");
  assert.equal(normalizeSpaces(formatMoney(120.5, "GEL")), "120,50 GEL");
  assert.equal(normalizeSpaces(formatMoney(7, "XYZ")), "7,00 XYZ");
  assert.equal(normalizeSpaces(formatMoney(Number.NaN, "USD")), "0,00 USD");
});

test("formats signed display money", () => {
  assert.equal(moneyDisplaySigned(12.5, "USD"), "+~$12,50");
  assert.equal(moneyDisplaySigned(-12.5, "USD"), "~$-12,50");
});

test("escapes html and attributes", () => {
  assert.equal(escapeHtml(`<b a="1">x&y'</b>`), "&lt;b a=&quot;1&quot;&gt;x&amp;y&#039;&lt;/b&gt;");
  assert.equal(escapeAttribute("line 1\nline 2"), "line 1 line 2");
});

test("formats dates for UI", () => {
  assert.equal(dateTimeLocal("2026-06-02T10:30:00Z").length, 16);
  assert.match(formatDateOnly("2026-06-02T10:30:00Z"), /02/);
});

test("formats dates in Bangkok timezone", () => {
  assert.match(formatDate("2026-05-31T17:00:00.000Z", "ru"), /01 июн|01 Ð¸ÑŽÐ½/);
  assert.equal(dateTimeLocal("2026-05-31T17:00:00.000Z"), "2026-06-01T00:00");
});

test("formats datetime-local values in a supplied timezone", () => {
  assert.equal(dateTimeLocal("2026-06-01T03:30:00.000Z", "America/New_York"), "2026-05-31T23:30");
});

test("formats user-local calendar keys independently of the browser timezone", () => {
  const value = new Date("2026-07-22T18:30:00.000Z");

  assert.equal(localDateKeyInTimeZone(value, "Asia/Bangkok"), "2026-07-23");
  assert.equal(localDateKeyInTimeZone(value, "America/New_York"), "2026-07-22");
});

function normalizeSpaces(value) {
  return value.replaceAll("\u00a0", " ");
}
