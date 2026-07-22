import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizePlannedDateKey,
  plannedOccurrenceDateKeysForPeriod
} from "../src/plannedOccurrenceDates.js";

test("preserves legacy monthly occurrence keys when starts_on is null", () => {
  assert.deepEqual(
    plannedOccurrenceDateKeysForPeriod({ recurrence: "monthly", due_day: 31, starts_on: null }, "2026-02"),
    ["2026-02-28"]
  );
});

test("filters weekly keys before starts_on and restores the full next month", () => {
  const plan = { recurrence: "weekly", weekday: 3, starts_on: "2026-07-23" };

  assert.deepEqual(plannedOccurrenceDateKeysForPeriod(plan, "2026-07"), ["2026-07-29"]);
  assert.deepEqual(
    plannedOccurrenceDateKeysForPeriod(plan, "2026-08"),
    ["2026-08-05", "2026-08-12", "2026-08-19", "2026-08-26"]
  );
});

test("keeps only the second twice-monthly key when start is between due days", () => {
  assert.deepEqual(
    plannedOccurrenceDateKeysForPeriod(
      { recurrence: "twice_monthly", due_days: [5, 20], starts_on: "2026-07-12" },
      "2026-07"
    ),
    ["2026-07-20"]
  );
});

test("excludes one-off before start and includes one-off on start", () => {
  assert.deepEqual(
    plannedOccurrenceDateKeysForPeriod(
      { recurrence: "one_off", due_date: "2026-07-19", starts_on: "2026-07-20" },
      "2026-07"
    ),
    []
  );
  assert.deepEqual(
    plannedOccurrenceDateKeysForPeriod(
      { recurrence: "one_off", due_date: "2026-07-20", starts_on: "2026-07-20" },
      "2026-07"
    ),
    ["2026-07-20"]
  );
});

for (const scenario of [
  {
    name: "monthly due before start",
    plan: { recurrence: "monthly", due_day: 10, starts_on: "2026-07-20" },
    period: "2026-07",
    expected: []
  },
  {
    name: "monthly due after start",
    plan: { recurrence: "monthly", due_day: 25, starts_on: "2026-07-20" },
    period: "2026-07",
    expected: ["2026-07-25"]
  },
  {
    name: "start after both due days",
    plan: { recurrence: "twice_monthly", due_days: [5, 20], starts_on: "2026-07-21" },
    period: "2026-07",
    expected: []
  },
  {
    name: "future start",
    plan: { recurrence: "monthly", due_day: 25, starts_on: "2026-08-01" },
    period: "2026-07",
    expected: []
  },
  {
    name: "clamped duplicates",
    plan: { recurrence: "twice_monthly", due_days: [30, 31] },
    period: "2026-02",
    expected: ["2026-02-28"]
  },
  {
    name: "one_time alias",
    plan: { recurrence: "one_time", due_date: "2026-07-22" },
    period: "2026-07",
    expected: ["2026-07-22"]
  }
]) {
  test(scenario.name, () => {
    assert.deepEqual(
      plannedOccurrenceDateKeysForPeriod(scenario.plan, scenario.period),
      scenario.expected
    );
  });
}

test("normalizes only real YYYY-MM-DD calendar dates", () => {
  assert.equal(normalizePlannedDateKey("2026-02-28"), "2026-02-28");
  assert.equal(normalizePlannedDateKey("2028-02-29"), "2028-02-29");
  assert.equal(normalizePlannedDateKey("2026-02-29"), null);
  assert.equal(normalizePlannedDateKey("2026-02-30"), null);
  assert.equal(normalizePlannedDateKey("not-a-date"), null);
});

test("rejects invalid periods without producing occurrence keys", () => {
  assert.deepEqual(plannedOccurrenceDateKeysForPeriod({ recurrence: "monthly", due_day: 1 }, "2026-13"), []);
  assert.deepEqual(plannedOccurrenceDateKeysForPeriod({ recurrence: "monthly", due_day: 1 }, "invalid"), []);
});
