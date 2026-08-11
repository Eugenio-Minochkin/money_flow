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

test("Shortcut completed replay is returned before the parser is invoked", async () => {
  let parserCalls = 0;
  const result = await createShortcutExpenseDraft({
    user: { id: 7 }, tokenId: 9, clientRequestId: "request-123", text: "coffee 120",
    expenseParser: { parse: async () => { parserCalls += 1; return { expenses: [] }; } },
    repository: {
      claimShortcutRequest: async () => {
        return { state: "completed", draft: { id: 42, items: [{ description: "coffee", amount: 120 }] } };
      }
    }
  });
  assert.equal(parserCalls, 0);
  assert.equal(result.draft.id, 42);
});

test("Shortcut concurrent request waits for the completed draft without invoking the parser", async () => {
  let parserCalls = 0;
  const result = await createShortcutExpenseDraft({
    user: { id: 7 }, tokenId: 9, clientRequestId: "request-other-process", text: "coffee 120",
    expenseParser: { parse: async () => { parserCalls += 1; return { expenses: [] }; } },
    repository: {
      claimShortcutRequest: async () => ({ state: "processing" }),
      waitForShortcutRequest: async () => ({ state: "completed", draft: { id: 46, items: [{ description: "coffee", amount: 120 }] } })
    }
  });
  assert.equal(parserCalls, 0);
  assert.equal(result.draft.id, 46);
  assert.equal(result.replayed, true);
});

test("Shortcut parser failure releases a processing claim for a later retry", async () => {
  const calls = [];
  let claims = 0;
  let parserFails = true;
  const repository = {
    claimShortcutRequest: async () => { claims += 1; return { state: "claimed", claimVersion: claims }; },
    releaseShortcutRequest: async (...args) => calls.push(args),
    completeShortcutRequest: async ({ items, claimVersion }) => ({ draft: { id: 45, items, claimVersion } })
  };
  const input = {
    user: { id: 7 }, tokenId: 9, clientRequestId: "request-456", text: "coffee 120", repository,
    expenseParser: { parse: async () => {
      if (parserFails) throw new Error("parser unavailable");
      return { expenses: [{ description: "coffee", amount: 120 }] };
    } }
  };
  await assert.rejects(
    () => createShortcutExpenseDraft(input),
    /parser unavailable/
  );
  assert.deepEqual(calls, [[9, 7, "request-456", 1]]);
  assert.equal(claims, 1);
  parserFails = false;
  const retry = await createShortcutExpenseDraft(input);
  assert.equal(retry.draft.id, 45);
  assert.equal(retry.draft.claimVersion, 2);
  assert.equal(claims, 2);
});

test("Shortcut parses after a short-lived claim and before the persistence transaction", async () => {
  let transactionOpen = false;
  const result = await createShortcutExpenseDraft({
    user: { id: 7 }, tokenId: 9, clientRequestId: "request-transaction-boundary", text: "coffee 120",
    expenseParser: { parse: async () => {
      assert.equal(transactionOpen, false);
      return { expenses: [{ description: "coffee", amount: 120 }] };
    } },
    repository: {
      claimShortcutRequest: async () => ({ state: "claimed" }),
      completeShortcutRequest: async ({ items }) => {
        transactionOpen = true;
        assert.deepEqual(items, [{ description: "coffee", amount: 120 }]);
        return { draft: { id: 43, items } };
      }
    }
  });
  assert.equal(result.draft.id, 43);
});

test("Same-process concurrent Shortcut retries share one parser call and draft", async () => {
  let parserCalls = 0;
  let resolveParser;
  const parserDone = new Promise((resolve) => { resolveParser = resolve; });
  const repository = {
    claimShortcutRequest: async () => ({ state: "claimed" }),
    completeShortcutRequest: async ({ items }) => ({ draft: { id: 44, items } }),
    recordAppEvent: async () => {}
  };
  const input = {
    user: { id: 7 }, tokenId: 9, clientRequestId: "request-concurrent", text: "coffee 120", repository,
    expenseParser: { parse: async () => {
      parserCalls += 1;
      await parserDone;
      return { expenses: [{ description: "coffee", amount: 120 }] };
    } }
  };
  const first = createShortcutExpenseDraft(input);
  const second = createShortcutExpenseDraft(input);
  resolveParser();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(parserCalls, 1);
  assert.equal(firstResult.draft.id, 44);
  assert.equal(secondResult.draft.id, 44);
});
