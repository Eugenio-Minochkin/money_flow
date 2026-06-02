import test from "node:test";
import assert from "node:assert/strict";

import { isDueToday, isPlannedPaid, nextPlannedItem, parseDueDays } from "../src/planned.js";

test("parses due days from comma separated input", () => {
  assert.deepEqual(parseDueDays("4, 18, nope, 40, 0"), [4, 18]);
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
