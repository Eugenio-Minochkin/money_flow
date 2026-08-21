import assert from "node:assert/strict";
import test from "node:test";

import { activatePreparedShortcut, prepareShortcutSetup } from "../src/quickAccessSetup.js";

test("preparation returns a memory-only key without activating a credential", async () => {
  const calls = [];
  const result = await prepareShortcutSetup({ telegramUserId: 100, api: async (path) => { calls.push(path); return { preparationId: "prep-1", token: "raw-key" }; } });
  assert.deepEqual(result, { status: "prepared", preparationId: "prep-1", token: "raw-key" });
  assert.deepEqual(calls, ["/api/quick-access-token-preparations"]);
});

test("preparation failure exposes no key or activation id", async () => {
  const result = await prepareShortcutSetup({ telegramUserId: 100, api: async () => { throw new Error("network down"); } });
  assert.equal(result.status, "preparation_failed");
  assert.equal(result.preparationId, null);
  assert.equal(result.token, null);
});

test("activation opens only after the explicit key handoff path", async () => {
  const calls = [];
  const result = await activatePreparedShortcut({ telegramUserId: 100, preparationId: "prep-1", shortcutUrl: "https://www.icloud.com/shortcuts/shared", api: async (path) => { calls.push(`api:${path}`); }, openShortcut: (url) => calls.push(`open:${url}`) });
  assert.deepEqual(result, { status: "activated" });
  assert.deepEqual(calls, ["api:/api/quick-access-token-preparations/prep-1/activate", "open:https://www.icloud.com/shortcuts/shared"]);
});

test("activation failure retains the prepared key for a manual retry", async () => {
  const result = await activatePreparedShortcut({ telegramUserId: 100, preparationId: "prep-1", shortcutUrl: "https://www.icloud.com/shortcuts/shared", api: async () => { throw new Error("network down"); }, openShortcut: () => assert.fail("must not open") });
  assert.equal(result.status, "activation_failed");
});

test("activation succeeds even if opening the shared Shortcut is unavailable", async () => {
  const result = await activatePreparedShortcut({ telegramUserId: 100, preparationId: "prep-1", shortcutUrl: "https://www.icloud.com/shortcuts/shared", api: async () => {}, openShortcut: () => { throw new Error("external links unavailable"); } });
  assert.deepEqual(result, { status: "activated" });
});
