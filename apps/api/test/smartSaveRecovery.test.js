import assert from "node:assert/strict";
import test from "node:test";

import { previewSmartSaveRecovery, saveSmartSaveRecovery } from "../src/smartSaveRecovery.js";

const safeItem = (description, spentAt = "2026-08-10T08:00:00.000Z") => ({
  amount: 100,
  currency: "THB",
  description,
  category_slug: "food_cafe",
  category_source: "parser",
  needs_review: false,
  spent_at: spentAt,
  budget_impact: "regular"
});

test("recovery preview counts every pending and inbox draft and separates safe from review", async () => {
  const drafts = [
    ...Array.from({ length: 8 }, (_, index) => ({ id: index + 1, status: index % 2 ? "pending" : "inbox", items: [safeItem(`safe ${index + 1}`)] })),
    { id: 9, status: "inbox", items: [{ ...safeItem("uncertain"), needs_review: true }] },
    { id: 10, status: "pending", items: [{ ...safeItem("other"), category_slug: "other" }] },
    { id: 11, status: "pending", items: [safeItem("one"), safeItem("two")] },
    { id: 12, status: "inbox", items: [safeItem("closed", "2026-07-12T08:00:00.000Z")] }
  ];
  const repository = {
    async listUnresolvedDraftsForTelegramUser() { return drafts; },
    async listClosedReserveMonthsForTelegramUser() { return ["2026-07"]; }
  };

  const preview = await previewSmartSaveRecovery({
    telegramUserId: 100,
    user: { timezone: "Asia/Bangkok" },
    repository,
    now: new Date("2026-08-14T12:00:00.000Z")
  });

  assert.equal(preview.totalUnresolved, 12);
  assert.equal(preview.safeCount, 8);
  assert.equal(preview.reviewCount, 4);
  assert.deepEqual(preview.safeDraftIds, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(preview.reviewDraftIds, [9, 10, 11, 12]);
  assert.equal(preview.drafts.length, 12);
});

test("recovery mutation re-reads and reclassifies every member before canonical save", async () => {
  const reads = [];
  const saves = [];
  const drafts = new Map([
    [1, { id: 1, status: "pending", items: [safeItem("taxi", "2026-08-08T03:00:00.000Z")] }],
    [2, { id: 2, status: "inbox", items: [{ ...safeItem("uncertain"), needs_review: true }] }],
    [3, { id: 3, status: "confirmed", items: [safeItem("coffee", "2026-08-09T03:00:00.000Z")] }],
    [4, { id: 4, status: "pending", items: [safeItem("closed", "2026-07-09T03:00:00.000Z")] }]
  ]);
  const repository = {
    async getUserByTelegramId() { return { id: 7, telegram_user_id: 100, timezone: "Asia/Bangkok" }; },
    async getDraftForTelegramUser(id) { reads.push(id); return drafts.get(id) ?? null; },
    async listClosedReserveMonthsForTelegramUser() { return ["2026-07"]; },
    async saveDraftAsExpense(id) {
      saves.push(id);
      return id === 3
        ? { expenses: [{ id: 303, draft_id: 3 }], alreadySaved: true }
        : { expenses: [{ id: 101, draft_id: id, spent_at: drafts.get(id).items[0].spent_at }], alreadySaved: false };
    }
  };

  const result = await saveSmartSaveRecovery({
    telegramUserId: 100,
    draftIds: [1, 2, 3, 4, 999, 1],
    repository,
    now: new Date("2026-08-14T12:00:00.000Z")
  });

  assert.deepEqual(reads, [1, 2, 3, 4, 999]);
  assert.deepEqual(saves, [1, 3]);
  assert.equal(result.savedCount, 1);
  assert.equal(result.alreadySavedCount, 1);
  assert.deepEqual(result.results.map(({ draftId, state, reason }) => ({ draftId, state, reason })), [
    { draftId: 1, state: "saved", reason: undefined },
    { draftId: 2, state: "review", reason: "needs_review" },
    { draftId: 3, state: "already_saved", reason: undefined },
    { draftId: 4, state: "review", reason: "closed_month" },
    { draftId: 999, state: "not_found", reason: undefined }
  ]);
  assert.equal(result.results[0].expenses[0].spent_at, "2026-08-08T03:00:00.000Z");
});

test("recovery retry reports canonical already-saved results without another financial fact", async () => {
  let inserts = 0;
  const draft = { id: 7, status: "pending", items: [safeItem("train")] };
  const repository = {
    async getUserByTelegramId() { return { id: 1, telegram_user_id: 100, timezone: "Asia/Bangkok" }; },
    async getDraftForTelegramUser() { return draft; },
    async listClosedReserveMonthsForTelegramUser() { return []; },
    async saveDraftAsExpense() {
      const alreadySaved = inserts > 0;
      inserts = 1;
      return { expenses: [{ id: 70, draft_id: 7 }], alreadySaved };
    }
  };

  const first = await saveSmartSaveRecovery({ telegramUserId: 100, draftIds: [7], repository });
  const retry = await saveSmartSaveRecovery({ telegramUserId: 100, draftIds: [7], repository });

  assert.equal(first.savedCount, 1);
  assert.equal(retry.alreadySavedCount, 1);
  assert.equal(inserts, 1);
});
