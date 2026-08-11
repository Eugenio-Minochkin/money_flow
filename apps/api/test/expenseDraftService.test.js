import assert from "node:assert/strict";
import test from "node:test";

import { createExpenseDraftFromText, createShortcutExpenseDraft, ExpenseTextNotRecognizedError } from "../src/expenseDraftService.js";

test("shared expense draft service creates the parser draft and records only safe source metadata", async () => {
  const calls = [];
  const draft = await createExpenseDraftFromText({
    user: { id: 7, base_currency: "THB", timezone: "Asia/Bangkok" },
    text: "coffee 120 baht",
    source: "miniapp",
    expenseParser: { parse: async () => ({ expenses: [{ description: "coffee", amount: 120 }] }) },
    repository: {
      createDraft: async (...args) => { calls.push(["draft", ...args]); return { id: 42 }; },
      recordAppEvent: async (...args) => calls.push(["event", ...args])
    }
  });
  assert.deepEqual(draft, { id: 42, items: [{ description: "coffee", amount: 120 }] });
  assert.deepEqual(calls, [
    ["draft", 7, "coffee 120 baht", [{ description: "coffee", amount: 120 }]],
    ["event", 7, "quick_entry_draft_created", { source: "miniapp" }]
  ]);
});

test("shared expense draft service rejects parser results without ordinary expenses", async () => {
  await assert.rejects(
    () => createExpenseDraftFromText({
      user: { id: 7 }, text: "hello", source: "ios_shortcut",
      expenseParser: { parse: async () => ({ expenses: [] }) }, repository: {}
    }),
    ExpenseTextNotRecognizedError
  );
});

test("Shortcut replay is returned before the parser is invoked", async () => {
  let parserCalls = 0;
  const result = await createShortcutExpenseDraft({
    user: { id: 7 }, tokenId: 9, clientRequestId: "request-123", text: "coffee 120",
    expenseParser: { parse: async () => { parserCalls += 1; return { expenses: [] }; } },
    repository: {
      createShortcutDraft: async ({ createItems }) => {
        assert.equal(typeof createItems, "function");
        return { replayed: true, draft: { id: 42, items: [{ description: "coffee", amount: 120 }] } };
      }
    }
  });
  assert.equal(parserCalls, 0);
  assert.equal(result.draft.id, 42);
});
