import test from "node:test";
import assert from "node:assert/strict";

import { runWithRetry } from "../src/db.js";

test("retries transient startup failures before succeeding", async () => {
  let attempts = 0;

  const result = await runWithRetry(async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error("not ready");
      error.code = "ECONNREFUSED";
      throw error;
    }
    return "ready";
  }, { retries: 3, delayMs: 1 });

  assert.equal(result, "ready");
  assert.equal(attempts, 3);
});
