import assert from "node:assert/strict";
import test from "node:test";

import { advanceShortcutSetup } from "../src/quickAccessSetup.js";

test("Shortcut setup never activates a prepared key when clipboard copy fails", async () => {
  const calls = [];
  const result = await advanceShortcutSetup({
    telegramUserId: 100,
    api: async (path) => {
      calls.push(path);
      return { preparationId: "prep-1", token: "raw-key" };
    },
    writeText: async () => { throw new Error("clipboard denied"); }
  });

  assert.equal(result.status, "preparation_failed");
  assert.equal(result.preparationId, null);
  assert.deepEqual(calls, ["/api/quick-access-token-preparations"]);
});

test("Shortcut activation failure retains the copied preparation for a retry", async () => {
  const calls = [];
  const result = await advanceShortcutSetup({
    telegramUserId: 100,
    api: async (path) => {
      calls.push(path);
      if (path.endsWith("/activate")) throw new Error("network down");
      return { preparationId: "prep-1", token: "raw-key" };
    },
    writeText: async () => {}
  });

  assert.equal(result.status, "activation_failed");
  assert.equal(result.preparationId, "prep-1");
  assert.deepEqual(calls, [
    "/api/quick-access-token-preparations",
    "/api/quick-access-token-preparations/prep-1/activate"
  ]);
});

test("Shortcut activation retry reuses the copied preparation without issuing another key", async () => {
  const calls = [];
  const result = await advanceShortcutSetup({
    telegramUserId: 100,
    preparationId: "prep-1",
    api: async (path) => { calls.push(path); return { ok: true }; },
    writeText: async () => { throw new Error("must not copy again"); }
  });

  assert.equal(result.status, "activated");
  assert.equal(result.preparationId, null);
  assert.deepEqual(calls, ["/api/quick-access-token-preparations/prep-1/activate"]);
});
