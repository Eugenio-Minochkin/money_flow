import test from "node:test";
import assert from "node:assert/strict";

import {
  calculatePlannedMonthSummary,
  buildPlannedOccurrences,
  defaultPlannedCurrency,
  dueOrOverduePlannedOccurrences,
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

test("builds occurrence dates for weekly and twice-monthly plans in the selected month", () => {
  assert.deepEqual(
    buildPlannedOccurrences(
      { recurrence: "weekly", weekday: 3, amount: 1000, currency: "THB" },
      new Date("2026-06-12T10:00:00+07:00")
    ).map((occurrence) => occurrence.occurrence_date),
    ["2026-06-03", "2026-06-10", "2026-06-17", "2026-06-24"]
  );

  assert.deepEqual(
    buildPlannedOccurrences(
      { recurrence: "twice_monthly", due_days: [5, 31], amount: 1500, currency: "THB" },
      new Date("2026-06-12T10:00:00+07:00")
    ).map((occurrence) => occurrence.occurrence_date),
    ["2026-06-05", "2026-06-30"]
  );
});

test("filters client occurrence keys by starts_on with server-compatible boundaries", () => {
  const july = new Date(2026, 6, 15);
  const cases = [
    {
      item: { recurrence: "weekly", weekday: 3, starts_on: "2026-07-23" },
      expected: ["2026-07-29"]
    },
    {
      item: { recurrence: "monthly", due_day: 10, starts_on: "2026-07-20" },
      expected: []
    },
    {
      item: { recurrence: "monthly", due_day: 25, starts_on: "2026-07-20" },
      expected: ["2026-07-25"]
    },
    {
      item: { recurrence: "twice_monthly", due_days: [5, 20], starts_on: "2026-07-12" },
      expected: ["2026-07-20"]
    },
    {
      item: { recurrence: "one_off", due_date: "2026-07-19", starts_on: "2026-07-20" },
      expected: []
    },
    {
      item: { recurrence: "one_off", due_date: "2026-07-20", starts_on: "2026-07-20" },
      expected: ["2026-07-20"]
    }
  ];

  for (const { item, expected } of cases) {
    assert.deepEqual(
      buildPlannedOccurrences(item, july).map((occurrence) => occurrence.occurrence_date),
      expected
    );
  }
  assert.deepEqual(
    buildPlannedOccurrences({ active: false, recurrence: "weekly", weekday: 3, starts_on: "2026-07-23" }, july),
    []
  );
  assert.deepEqual(
    buildPlannedOccurrences({ recurrence: "weekly", weekday: 3, starts_on: null }, july)
      .map((occurrence) => occurrence.occurrence_date),
    ["2026-07-01", "2026-07-08", "2026-07-15", "2026-07-22", "2026-07-29"]
  );
});

test("keeps recurring planned item payable until all current month occurrences are paid", () => {
  const item = {
    id: 1,
    recurrence: "weekly",
    weekday: 3,
    amount_base: 1000,
    display: { amount: 1000, currency: "THB" },
    paid_occurrence_dates: ["2026-06-03"]
  };
  const now = new Date("2026-06-12T10:00:00+07:00");

  assert.equal(isPlannedPaid(item, now), false);
  assert.equal(nextUnpaidPlannedItem([item], now).date.toISOString().slice(0, 10), "2026-06-10");
  assert.deepEqual(calculatePlannedMonthSummary([item], now), {
    total: 4000,
    paid: 1000,
    remaining: 3000,
    display: {
      total: 4000,
      paid: 1000,
      remaining: 3000,
      currency: "THB"
    }
  });
});

test("monthly plan stays payable after its due day when nothing is paid", () => {
  const now = new Date("2026-06-16T10:00:00+07:00");
  const item = {
    id: 1,
    recurrence: "monthly",
    due_day: 6,
    due_days: [6],
    amount: 17000,
    currency: "THB",
    paid_count: 0,
    paid_occurrence_dates: []
  };

  const occurrences = buildPlannedOccurrences(item, now);
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].occurrence_date, "2026-06-06");
  assert.equal(occurrences[0].paid, false);
  assert.equal(isPlannedPaid(item, now), false);
});

test("monthly plan is paid only when the occurrence has a linked expense", () => {
  const now = new Date("2026-06-16T10:00:00+07:00");
  const paid = {
    id: 1,
    recurrence: "monthly",
    due_day: 6,
    due_days: [6],
    amount: 17000,
    currency: "THB",
    paid_occurrence_dates: ["2026-06-06"],
    paid_occurrences: { "2026-06-06": { expense_id: 42, paid_at: "2026-06-06T09:00:00Z" } }
  };

  assert.equal(isPlannedPaid(paid, now), true);
});

test("monthly plan is not paid when the payment record lacks a valid expense (broken state)", () => {
  const now = new Date("2026-06-16T10:00:00+07:00");
  const broken = {
    id: 1,
    recurrence: "monthly",
    due_day: 6,
    due_days: [6],
    amount: 17000,
    currency: "THB",
    paid_occurrence_dates: ["2026-06-06"],
    paid_occurrences: { "2026-06-06": { expense_id: null, paid_at: "2026-06-16T09:00:00Z" } }
  };

  const occurrences = buildPlannedOccurrences(broken, now);
  assert.equal(occurrences[0].paid, false);
  assert.equal(isPlannedPaid(broken, now), false);
});

test("twice-monthly plan reports honest 1/2 progress while partly paid", () => {
  const now = new Date("2026-06-16T10:00:00+07:00");
  const item = {
    id: 1,
    recurrence: "twice_monthly",
    due_days: [4, 17],
    amount: 2000,
    currency: "THB",
    paid_occurrence_dates: ["2026-06-04"],
    paid_occurrences: { "2026-06-04": { expense_id: 7 } }
  };

  const occurrences = buildPlannedOccurrences(item, now);
  assert.equal(occurrences.length, 2);
  const paidCount = occurrences.filter((occurrence) => occurrence.paid).length;
  assert.equal(paidCount, 1);
  assert.equal(isPlannedPaid(item, now), false);
});

test("weekly plan stays payable while a past occurrence is unpaid", () => {
  const now = new Date("2026-06-16T10:00:00+07:00");
  const item = {
    id: 1,
    recurrence: "weekly",
    weekday: 3,
    amount: 1000,
    currency: "THB",
    paid_occurrence_dates: [],
    paid_occurrences: {}
  };

  assert.equal(isPlannedPaid(item, now), false);
  const next = nextUnpaidPlannedItem([item], now);
  assert.equal(next.occurrence.occurrence_date, "2026-06-03");
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

test("dueOrOverduePlannedOccurrences excludes future, paid and inactive occurrences", () => {
  const now = new Date("2026-06-18T10:00:00+07:00");
  const items = [
    { id: 1, recurrence: "monthly", due_day: 18, due_days: [18], amount: 100, currency: "THB", description: "today" },
    { id: 2, recurrence: "monthly", due_day: 10, due_days: [10], amount: 200, currency: "THB", description: "overdue", paid_count: 0 },
    { id: 3, recurrence: "monthly", due_day: 10, due_days: [10], amount: 300, currency: "THB", description: "paid-overdue", paid_occurrence_dates: ["2026-06-10"], paid_occurrences: { "2026-06-10": { expense_id: 9 } } },
    { id: 4, recurrence: "monthly", due_day: 25, due_days: [25], amount: 400, currency: "THB", description: "future" },
    { id: 5, active: false, recurrence: "monthly", due_day: 5, due_days: [5], amount: 500, currency: "THB", description: "inactive" }
  ];

  const result = dueOrOverduePlannedOccurrences(items, now).map((entry) => ({
    id: entry.item.id,
    date: entry.occurrence.occurrence_date,
    isToday: entry.isToday
  }));

  assert.deepEqual(result, [
    { id: 2, date: "2026-06-10", isToday: false },
    { id: 1, date: "2026-06-18", isToday: true }
  ]);
});

test("dueOrOverduePlannedOccurrences keeps a future-only month empty", () => {
  const now = new Date("2026-06-17T10:00:00+07:00");
  const items = [
    { id: 1, recurrence: "monthly", due_day: 18, due_days: [18], amount: 100, currency: "THB" }
  ];

  assert.deepEqual(dueOrOverduePlannedOccurrences(items, now), []);
});
