import test from "node:test";
import assert from "node:assert/strict";

import { groupByDay } from "../src/history.js";

test("groups expenses by local calendar day and sums base amounts", () => {
  const groups = groupByDay([
    { spent_at: "2026-06-02T10:00:00+07:00", amount_base: 70, amount_original: 70 },
    { spent_at: "2026-06-02T12:00:00+07:00", amount_base: 80, amount_original: 80 },
    { spent_at: "2026-06-03T12:00:00+07:00", amount_original: 120 }
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].total, 150);
  assert.equal(groups[0].items.length, 2);
  assert.equal(groups[1].total, 120);
});
