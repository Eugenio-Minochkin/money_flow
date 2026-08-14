import assert from "node:assert/strict";
import test from "node:test";
import { isQuickCaptureAutoSaveEligible, processMiniAppQuickCapture } from "../src/quickCapture.js";

test("only a confident single-item Quick Capture may save immediately", () => {
  const safe = { amount: 70, currency: "THB", spent_at: "2026-08-14T08:00:00.000Z", category_slug: "food_cafe", needs_review: false };
  assert.equal(isQuickCaptureAutoSaveEligible([safe], { now: new Date("2026-08-14T09:00:00.000Z") }), true);
  assert.equal(isQuickCaptureAutoSaveEligible([{ ...safe, category_slug: "other", category_source: "parser" }]), false);
  assert.equal(isQuickCaptureAutoSaveEligible([{ ...safe, needs_review: true }]), false);
  assert.equal(isQuickCaptureAutoSaveEligible([
    safe,
    { ...safe, category_slug: "transport" }
  ]), false);
});

test("safe Quick Capture replay returns the one already-saved expense", async () => {
  let parserCalls = 0;
  const drafts = new Map();
  const expenses = new Map();
  const repository = {
    async claimMiniAppQuickCaptureRequest(userId, clientRequestId) {
      const prior = drafts.get(`${userId}:${clientRequestId}`);
      return prior ? { state: "completed", draft: prior } : { state: "claimed", claimVersion: 1 };
    },
    async completeMiniAppQuickCaptureRequest({ userId, clientRequestId, items }) {
      const draft = { id: 42, items };
      drafts.set(`${userId}:${clientRequestId}`, draft);
      return { draft };
    },
    async saveDraftAsExpense(draftId) {
      const alreadySaved = expenses.has(draftId);
      if (!alreadySaved) expenses.set(draftId, [{ id: 81, draft_id: draftId }]);
      return { expenses: expenses.get(draftId), alreadySaved };
    },
    async recordAppEvent() {}
  };
  const input = {
    user: { id: 7, telegram_user_id: 100, base_currency: "THB" }, clientRequestId: "miniapp-save-replay", text: "coffee 120",
    expenseParser: { parse: async () => { parserCalls += 1; return { expenses: [{ amount: 120, currency: "THB", spent_at: "2026-08-14T08:00:00.000Z", category_slug: "food_cafe", category_source: "parser", needs_review: false }] }; } },
    repository
  };

  const first = await processMiniAppQuickCapture(input);
  const replay = await processMiniAppQuickCapture(input);

  assert.deepEqual(replay.saved.expenses, first.saved.expenses);
  assert.equal(drafts.size, 1);
  assert.equal(expenses.size, 1);
  assert.equal(parserCalls, 1);
});

test("review Quick Capture replay returns its original draft", async () => {
  let parserCalls = 0;
  const draft = { id: 52, items: [{ category_slug: "other", category_source: "parser", needs_review: true }] };
  const repository = {
    async claimMiniAppQuickCaptureRequest() { return parserCalls ? { state: "completed", draft } : { state: "claimed", claimVersion: 1 }; },
    async completeMiniAppQuickCaptureRequest() { return { draft }; },
    async recordAppEvent() {}
  };
  const input = {
    user: { id: 7, telegram_user_id: 100 }, clientRequestId: "miniapp-review-replay", text: "coffee",
    expenseParser: { parse: async () => { parserCalls += 1; return { expenses: draft.items }; } }, repository
  };

  const first = await processMiniAppQuickCapture(input);
  const replay = await processMiniAppQuickCapture(input);

  assert.equal(first.draft.id, 52);
  assert.equal(replay.draft.id, 52);
  assert.equal(parserCalls, 1);
});
