import assert from "node:assert/strict";
import test from "node:test";

import { describeQuickCaptureSavedResult } from "../src/quickCaptureSavedResult.js";

test("Quick Capture single save keeps the expense actions", () => {
  const expense = { id: 1, description: "coffee" };

  assert.deepEqual(describeQuickCaptureSavedResult([expense]), { kind: "single", expense });
});

test("Quick Capture multi save is a count-only result without single-expense actions", () => {
  const result = describeQuickCaptureSavedResult([{ id: 1 }, { id: 2 }, { id: 3 }]);

  assert.deepEqual(result, { kind: "multiple", count: 3 });
  assert.equal("expense" in result, false);
});
