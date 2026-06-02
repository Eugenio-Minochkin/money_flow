import test from "node:test";
import assert from "node:assert/strict";

import { inboxDraftDescription, inboxDraftTotal, updateFirstInboxItemCategory } from "../src/inbox.js";

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
