import assert from "node:assert/strict";
import test from "node:test";

import { deadlineSignal } from "../src/deadlineSignal.js";

test("deadlineSignal aborts when its parent job is aborted", async () => {
  const controller = new AbortController();
  const signal = deadlineSignal(controller.signal, 10_000);

  controller.abort(new Error("job stopped"));

  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.message, "job stopped");
});

test("deadlineSignal applies a finite request timeout without a parent", async () => {
  const signal = deadlineSignal(null, 5);
  await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.name, "TimeoutError");
});
