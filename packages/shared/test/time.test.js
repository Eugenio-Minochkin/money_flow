import test from "node:test";
import assert from "node:assert/strict";

import { localPeriodBounds } from "../src/time.js";

test("returns current week bounds from Monday in local timezone", () => {
  const bounds = localPeriodBounds(new Date("2026-06-07T10:00:00+07:00"), "week");

  assert.equal(bounds.start.toISOString(), "2026-05-31T17:00:00.000Z");
  assert.equal(bounds.end.toISOString(), "2026-06-07T17:00:00.000Z");
});
