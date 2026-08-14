import test from "node:test";
import assert from "node:assert/strict";

import {
  inboxCountLabel,
  inboxDraftDescription,
  inboxSummaryPreview,
  inboxDraftTotal,
  smartSaveRecoveryPrimaryAction,
  smartSaveRecoveryReviewAction,
  smartSaveRecoverySummary,
  smartSaveRecoveryTitle,
  shouldShowInboxOnDashboard,
  updateFirstInboxItemCategory
} from "../src/inbox.js";

test("formats Smart Save recovery counts and actions", () => {
  const preview = { totalUnresolved: 18, safeCount: 14, reviewCount: 4 };

  assert.equal(smartSaveRecoveryTitle(preview.totalUnresolved, "ru"), "Нужно разобрать 18 расходов");
  assert.equal(smartSaveRecoverySummary(preview, "ru"), "14 можно сохранить сразу · 4 нужно уточнить");
  assert.equal(smartSaveRecoveryPrimaryAction(preview.safeCount, "ru"), "Сохранить 14 понятных");
  assert.equal(smartSaveRecoveryReviewAction(preview.reviewCount, "ru"), "Разобрать 4");
  assert.equal(smartSaveRecoveryTitle(1, "en"), "Review 1 expense");
  assert.equal(smartSaveRecoverySummary({ safeCount: 1, reviewCount: 2 }, "en"), "1 can be saved now · 2 need review");
});

test("formats inbox draft description and total", () => {
  const draft = {
    source_text: "кофе и такси",
    items: [
      { amount: 70, description: "кофе" },
      { amount: 120, description: "такси" }
    ]
  };

  assert.equal(inboxDraftDescription(draft), "кофе, такси");
  assert.equal(inboxDraftTotal(draft), 190);
});

test("updates first inbox item category and marks it reviewed", () => {
  const draft = {
    items: [
      { amount: 70, description: "кофе", category_slug: "other", needs_review: true, confidence: 0.3 },
      { amount: 120, description: "такси", category_slug: "transport", needs_review: false, confidence: 0.9 }
    ]
  };

  const items = updateFirstInboxItemCategory(draft, "food_cafe");

  assert.equal(items[0].category_slug, "food_cafe");
  assert.equal(items[0].needs_review, false);
  assert.equal(items[0].confidence, 0.9);
  assert.equal(items[1].category_slug, "transport");
  assert.notEqual(items, draft.items);
});

test("shows dashboard inbox when there are drafts to review", () => {
  assert.equal(shouldShowInboxOnDashboard([]), false);
  assert.equal(shouldShowInboxOnDashboard([{ id: 1, status: "inbox" }]), true);
});

test("inboxCountLabel formats Russian draft counts with correct pluralization", () => {
  assert.equal(inboxCountLabel(1, "ru"), "Нужно проверить 1 трату");
  assert.equal(inboxCountLabel(2, "ru"), "Нужно проверить 2 траты");
  assert.equal(inboxCountLabel(5, "ru"), "Нужно проверить 5 трат");
  assert.equal(inboxCountLabel(11, "ru"), "Нужно проверить 11 трат");
  assert.equal(inboxCountLabel(21, "ru"), "Нужно проверить 21 трату");
  assert.equal(inboxCountLabel(22, "ru"), "Нужно проверить 22 траты");
  assert.equal(inboxCountLabel(25, "ru"), "Нужно проверить 25 трат");
});

test("inboxCountLabel formats English draft counts with singular/plural", () => {
  assert.equal(inboxCountLabel(1, "en"), "Review 1 expense");
  assert.equal(inboxCountLabel(2, "en"), "Review 2 expenses");
  assert.equal(inboxCountLabel(5, "en"), "Review 5 expenses");
});

test("inboxCountLabel never leaves a bare count placeholder", () => {
  for (const language of ["ru", "en"]) {
    assert.doesNotMatch(inboxCountLabel(2, language), /:\s*\d/);
    assert.doesNotMatch(inboxCountLabel(2, language), /\{count\}/);
  }
  assert.equal(inboxCountLabel(0, "ru"), "Нужно проверить 0 трат");
});

test("inboxSummaryPreview shows the first draft and the remaining count", () => {
  const drafts = [
    { items: [{ description: "молоко", amount: 20, currency: "THB" }] },
    { items: [{ description: "такси", amount: 120, currency: "THB" }] },
    { items: [{ description: "кофе", amount: 80, currency: "THB" }] }
  ];
  const format = (amount, currency) => `${amount} ${currency}`;

  assert.equal(inboxSummaryPreview(drafts.slice(0, 1), "ru", format), "молоко · 20 THB");
  assert.equal(inboxSummaryPreview(drafts, "ru", format), "молоко · 20 THB · + ещё 2");
  assert.equal(inboxSummaryPreview(drafts, "en", format), "молоко · 20 THB · + 2 more");
});
