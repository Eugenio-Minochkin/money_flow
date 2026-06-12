import test from "node:test";
import assert from "node:assert/strict";

import {
  calculatePlannedMonthSummary,
  defaultPlannedCurrency,
  isDueToday,
  isPlannedPaid,
  nextPlannedItem,
  nextUnpaidPlannedItem,
  parseDueDays
} from "../src/planned.js";

test("parses due days from comma separated input", () => {
  assert.deepEqual(parseDueDays("4, 18, nope, 40, 0"), [4, 18]);
});

test("defaults planned currency to user base currency", () => {
  assert.equal(defaultPlannedCurrency({}, "IDR"), "IDR");
  assert.equal(defaultPlannedCurrency({ currency: "USD" }, "IDR"), "USD");
});

test("finds the next planned item across recurrence types", () => {
  const now = new Date("2026-06-02T10:00:00+07:00");
  const next = nextPlannedItem([
    { id: 1, recurrence: "monthly", due_day: 20 },
    { id: 2, recurrence: "weekly", weekday: 3 },
    { id: 3, recurrence: "one_off", due_date: "2026-06-05" }
  ], now);

  assert.equal(next.item.id, 2);
});

test("detects due and paid planned items", () => {
  const today = new Date("2026-06-02T10:00:00+07:00");

  assert.equal(isDueToday({ recurrence: "monthly", due_day: 2 }, today), true);
  assert.equal(isDueToday({ recurrence: "weekly", weekday: 2 }, today), true);
  assert.equal(isPlannedPaid({ paid_count: 1 }), true);
  assert.equal(isPlannedPaid({ paid_month: null }), false);
});

test("finds next unpaid planned item and skips already paid items", () => {
  const now = new Date("2026-06-03T10:00:00+07:00");
  const next = nextUnpaidPlannedItem([
    { id: 1, recurrence: "monthly", due_day: 3, paid_count: 1 },
    { id: 2, recurrence: "monthly", due_day: 4, paid_count: 0 }
  ], now);

  assert.equal(next.item.id, 2);
});

test("calculates current month planned summary from active occurrences", () => {
  const summary = calculatePlannedMonthSummary([
    {
      active: true,
      recurrence: "monthly",
      due_day: 8,
      amount_base: 690,
      display: { amount: 21.13, currency: "USD" },
      paid_count: 1
    },
    {
      active: true,
      recurrence: "weekly",
      weekday: 2,
      amount_base: 1100,
      display: { amount: 33.69, currency: "USD" },
      paid_count: 3
    },
    {
      active: true,
      recurrence: "twice_monthly",
      due_days: [4, 18],
      amount_base: 2000,
      display: { amount: 61.26, currency: "USD" },
      paid_count: 0
    },
    {
      active: false,
      recurrence: "monthly",
      due_day: 10,
      amount_base: 9999,
      display: { amount: 300, currency: "USD" },
      paid_count: 0
    },
    {
      active: true,
      recurrence: "one_off",
      due_date: "2026-07-01",
      amount_base: 5000,
      display: { amount: 153.14, currency: "USD" },
      paid_count: 0
    }
  ], new Date("2026-06-12T10:00:00+07:00"));

  assert.deepEqual(summary, {
    total: 10190,
    paid: 3990,
    remaining: 6200,
    display: {
      total: 312.1,
      paid: 122.2,
      remaining: 189.9,
      currency: "USD"
    }
  });
});
