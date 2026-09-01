import test from "node:test";
import assert from "node:assert/strict";

import * as settingsModule from "../src/settings.js";

const {
  COMMON_TIMEZONES,
  commitMonthlyBudgetChange,
  createSettingsSaveQueue,
  detectBrowserTimeZone,
  filterTimeZones,
  normalizeSettingsTimeZone,
  shouldShowCurrentMonthBudgetOverride
  ,timeZoneOffsetLabel
} = settingsModule;

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

test("accepts every runtime-valid IANA timezone and only falls back for invalid values", () => {
  assert.equal(normalizeSettingsTimeZone("Europe/Moscow"), "Europe/Moscow");
  assert.equal(normalizeSettingsTimeZone("Asia/Kolkata"), "Asia/Kolkata");
  assert.equal(normalizeSettingsTimeZone("America/Sao_Paulo"), "America/Sao_Paulo");
  assert.equal(normalizeSettingsTimeZone("Mars/Olympus"), "Asia/Bangkok");
  assert.equal(COMMON_TIMEZONES.includes("Asia/Bangkok"), true);
});

test("bundled timezone catalogue works without supportedValuesOf and excludes Asia/Bali", () => {
  const zones = settingsModule.allTimeZones({ DateTimeFormat: Intl.DateTimeFormat });
  for (const zone of ["Asia/Tokyo", "Europe/Oslo", "Australia/Sydney", "America/Sao_Paulo", "America/New_York", "Africa/Johannesburg", "Asia/Almaty", "Asia/Makassar"]) {
    assert.ok(zones.includes(zone));
  }
  assert.equal(zones.includes("Asia/Bali"), false);
  assert.ok(filterTimeZones("cape town").includes("Africa/Johannesburg"));
});

test("timezone labels use offsets for the supplied instant including fractional offsets", () => {
  assert.equal(timeZoneOffsetLabel("America/New_York", new Date("2026-01-15T12:00:00Z")), "UTC−05:00");
  assert.equal(timeZoneOffsetLabel("America/New_York", new Date("2026-07-15T12:00:00Z")), "UTC−04:00");
  assert.equal(timeZoneOffsetLabel("Asia/Kolkata", new Date("2026-07-15T12:00:00Z")), "UTC+05:30");
  assert.equal(timeZoneOffsetLabel("Australia/Eucla", new Date("2026-07-15T12:00:00Z")), "UTC+08:45");
});

test("timezone search normalizes city punctuation, spaces, underscores and case", () => {
  for (const query of ["new york", "New_York", "America/New_York", "utc-05:00"]) {
    assert.ok(filterTimeZones(query, new Date("2026-01-15T12:00:00Z")).includes("America/New_York"));
  }
});

test("detects browser timezone when it is in the supported list", () => {
  const detected = detectBrowserTimeZone({
    DateTimeFormat() {
      return { resolvedOptions: () => ({ timeZone: "Asia/Tbilisi" }) };
    }
  });

  assert.equal(detected, "Asia/Tbilisi");
});

test("keeps a valid browser timezone outside the common picker section", () => {
  const detected = detectBrowserTimeZone({
    DateTimeFormat() {
      return { resolvedOptions: () => ({ timeZone: "Asia/Kolkata" }) };
    }
  });

  assert.equal(detected, "Asia/Kolkata");
});

test("settings autosave queue skips initial and unchanged state", async () => {
  assert.equal(typeof createSettingsSaveQueue, "function");
  if (!createSettingsSaveQueue) return;
  const saved = [];
  const queue = createSettingsSaveQueue({
    save: async (settings) => {
      saved.push(settings);
      return settings;
    }
  });
  const initial = { baseCurrency: "THB", displayCurrency: "USD" };

  queue.reset(initial);
  await queue.enqueue({ ...initial });

  assert.deepEqual(saved, []);
});

test("settings autosave queue serializes rapid changes and saves the latest full state", async () => {
  assert.equal(typeof createSettingsSaveQueue, "function");
  if (!createSettingsSaveQueue) return;
  const calls = [];
  const pending = [];
  const queue = createSettingsSaveQueue({
    save(settings) {
      calls.push(settings);
      return new Promise((resolve) => pending.push(() => resolve(settings)));
    }
  });
  queue.reset({ baseCurrency: "THB", displayCurrency: "USD" });

  const first = queue.enqueue({ baseCurrency: "RUB", displayCurrency: "USD" });
  const second = queue.enqueue({ baseCurrency: "RUB", displayCurrency: "EUR" });
  await Promise.resolve();

  assert.deepEqual(calls, [{ baseCurrency: "RUB", displayCurrency: "USD" }]);
  pending.shift()();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, [
    { baseCurrency: "RUB", displayCurrency: "USD" },
    { baseCurrency: "RUB", displayCurrency: "EUR" }
  ]);
  pending.shift()();
  await Promise.all([first, second]);
});

test("settings autosave failure restores the last confirmed server state", async () => {
  assert.equal(typeof createSettingsSaveQueue, "function");
  if (!createSettingsSaveQueue) return;
  const errors = [];
  const queue = createSettingsSaveQueue({
    save: async () => { throw new Error("offline"); },
    onError: (error, confirmed) => errors.push({ message: error.message, confirmed })
  });
  const initial = { interfaceTheme: "light" };
  queue.reset(initial);

  await queue.enqueue({ interfaceTheme: "dark" });

  assert.deepEqual(errors, [{ message: "offline", confirmed: initial }]);
  assert.deepEqual(queue.confirmed(), initial);
});

test("monthly budget change requires confirmation before saving", async () => {
  assert.equal(typeof commitMonthlyBudgetChange, "function");
  if (!commitMonthlyBudgetChange) return;
  const saved = [];
  const outcome = await commitMonthlyBudgetChange({
    currentValue: 51000,
    rawValue: "56000",
    confirm: ({ currentValue, nextValue }) => currentValue === 51000 && nextValue === 56000,
    save: async (value) => saved.push(value)
  });

  assert.equal(outcome.status, "saved");
  assert.deepEqual(saved, [56000]);
});

test("monthly budget cancellation and invalid input never save", async () => {
  assert.equal(typeof commitMonthlyBudgetChange, "function");
  if (!commitMonthlyBudgetChange) return;
  const saved = [];
  let confirmations = 0;
  const options = {
    currentValue: 51000,
    confirm: () => { confirmations += 1; return false; },
    save: async (value) => saved.push(value)
  };

  assert.equal((await commitMonthlyBudgetChange({ ...options, rawValue: "56000" })).status, "cancelled");
  assert.equal((await commitMonthlyBudgetChange({ ...options, rawValue: "" })).status, "invalid");
  assert.equal((await commitMonthlyBudgetChange({ ...options, rawValue: "0" })).status, "invalid");
  assert.equal(confirmations, 1);
  assert.deepEqual(saved, []);
});
