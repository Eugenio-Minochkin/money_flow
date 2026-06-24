import test from "node:test";
import assert from "node:assert/strict";

import {
  inboxCountLabel,
  inboxDraftDescription,
  inboxDraftTotal,
  shouldShowInboxOnDashboard,
  updateFirstInboxItemCategory
} from "../src/inbox.js";

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
