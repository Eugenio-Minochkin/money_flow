import test from "node:test";
import assert from "node:assert/strict";

import { COMMON_TIMEZONES, detectBrowserTimeZone, normalizeSettingsTimeZone, shouldShowCurrentMonthBudgetOverride } from "../src/settings.js";

test("hides current month budget block when calculated budget has no override", () => {
  assert.equal(shouldShowCurrentMonthBudgetOverride({
    monthKey: "2026-06",
    amount: 45000,
    regularMonthlyBudget: 45000,
    hasOverride: false,
    isPartialMonth: false
  }, new Date("2026-06-13T10:00:00+07:00")), false);
});

test("shows current month budget block for active partial override in this calendar month", () => {
  assert.equal(shouldShowCurrentMonthBudgetOverride({
    monthKey: "2026-06",
    amount: 12000,
    regularMonthlyBudget: 45000,
    hasOverride: true,
    isPartialMonth: true
  }, new Date("2026-06-13T10:00:00+07:00")), true);
});

test("hides expired partial override after the calendar month changes", () => {
  assert.equal(shouldShowCurrentMonthBudgetOverride({
    monthKey: "2026-06",
    amount: 12000,
    regularMonthlyBudget: 45000,
    hasOverride: true,
    isPartialMonth: true
  }, new Date("2026-07-01T10:00:00+07:00")), false);
});

test("does not show non-partial overrides as first-month budget blocks", () => {
  assert.equal(shouldShowCurrentMonthBudgetOverride({
    monthKey: "2026-06",
    amount: 45000,
    regularMonthlyBudget: 45000,
    hasOverride: true,
    isPartialMonth: false
  }, new Date("2026-06-13T10:00:00+07:00")), false);
});

test("normalizes timezone settings to a short supported list", () => {
  assert.equal(normalizeSettingsTimeZone("Europe/Moscow"), "Europe/Moscow");
  assert.equal(normalizeSettingsTimeZone("Mars/Olympus"), "Asia/Bangkok");
  assert.equal(COMMON_TIMEZONES.includes("Asia/Bangkok"), true);
});

test("detects browser timezone when it is in the supported list", () => {
  const detected = detectBrowserTimeZone({
    DateTimeFormat() {
      return { resolvedOptions: () => ({ timeZone: "Asia/Tbilisi" }) };
    }
  });

  assert.equal(detected, "Asia/Tbilisi");
});
