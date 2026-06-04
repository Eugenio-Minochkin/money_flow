import test from "node:test";
import assert from "node:assert/strict";

import {
  dateTimeLocal,
  escapeAttribute,
  escapeHtml,
  formatDateOnly,
  moneyBase,
  moneyDisplay,
  moneyDisplaySigned
} from "../src/formatters.js";

test("formats base and display money", () => {
  assert.equal(normalizeSpaces(moneyBase(15269.99)), "15 269,99 THB");
  assert.equal(normalizeSpaces(moneyBase(14000, "IDR")), "14 000 IDR");
  assert.equal(moneyDisplay(69.44, "USD"), "~$69,44");
  assert.equal(normalizeSpaces(moneyDisplay(5000, "RUB")), "5 000 RUB");
  assert.equal(moneyDisplay(null, "USD"), "");
});

test("formats signed display money", () => {
  assert.equal(moneyDisplaySigned(12.5, "USD"), "+~$12,5");
  assert.equal(moneyDisplaySigned(-12.5, "USD"), "~$-12,5");
});

test("escapes html and attributes", () => {
  assert.equal(escapeHtml(`<b a="1">x&y'</b>`), "&lt;b a=&quot;1&quot;&gt;x&amp;y&#039;&lt;/b&gt;");
  assert.equal(escapeAttribute("line 1\nline 2"), "line 1 line 2");
});

test("formats dates for UI", () => {
  assert.equal(dateTimeLocal("2026-06-02T10:30:00Z").length, 16);
  assert.match(formatDateOnly("2026-06-02T10:30:00Z"), /02/);
});

function normalizeSpaces(value) {
  return value.replaceAll("\u00a0", " ");
}
