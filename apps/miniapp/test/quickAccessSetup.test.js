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

test("Shortcut setup opens the shared Shortcut only after its key is copied and activated", async () => {
  const calls = [];
  const result = await advanceShortcutSetup({
    telegramUserId: 100,
    shortcutUrl: "https://www.icloud.com/shortcuts/shared-money-flow",
    api: async (path) => {
      calls.push(`api:${path}`);
      if (path.endsWith("/activate")) return { ok: true };
      return { preparationId: "prep-1", token: "raw-key" };
    },
    writeText: async () => { calls.push("clipboard"); },
    openShortcut: (url) => { calls.push(`open:${url}`); }
  });

  assert.equal(result.status, "activated");
  assert.deepEqual(calls, [
    "api:/api/quick-access-token-preparations",
    "clipboard",
    "api:/api/quick-access-token-preparations/prep-1/activate",
    "open:https://www.icloud.com/shortcuts/shared-money-flow"
  ]);
});

test("Shortcut setup stays activated when opening the shared Shortcut is unavailable", async () => {
  const result = await advanceShortcutSetup({
    telegramUserId: 100,
    shortcutUrl: "https://www.icloud.com/shortcuts/shared-money-flow",
    api: async (path) => path.endsWith("/activate") ? { ok: true } : { preparationId: "prep-1", token: "raw-key" },
    writeText: async () => {},
    openShortcut: () => { throw new Error("external links unavailable"); }
  });

  assert.deepEqual(result, { status: "activated", preparationId: null });
});
