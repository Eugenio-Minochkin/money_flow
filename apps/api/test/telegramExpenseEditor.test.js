import test from "node:test";
import assert from "node:assert/strict";

import {
  applyDraftEditorChange,
  applySavedExpenseEditorChange,
  editorMessageForCode,
  editorTargetKey,
  expenseDateKeyboard,
  expenseEditorKeyboard,
  expenseInputPrompt,
  expenseCategoryKeyboard,
  expenseTreatmentKeyboard,
  formatExpenseEditor,
  parseExpenseEditorCallback,
  treatmentLabels
} from "../src/telegramExpenseEditor.js";

const draftTarget = {
  type: "draft",
  id: 42,
  itemIndex: 0,
  item: {
    amount: 120,
    currency: "THB",
    description: "coffee <milk>",
    category_slug: "food_cafe",
    tags: ["work", "morning"],
    spent_at: "2026-07-12T12:30:00.000Z",
    budget_impact: "regular"
  }
};

test("parses compact expense editor callbacks without accepting malformed data", () => {
  assert.deepEqual(parseExpenseEditorCallback("ee:d:42:0:o"), {
    type: "draft", id: 42, itemIndex: 0, action: "open"
  });
  assert.deepEqual(parseExpenseEditorCallback("ee:x:91:f:a"), {
    type: "expense", id: 91, action: "field", field: "amount"
  });
  assert.deepEqual(parseExpenseEditorCallback("ee:x:91:b:l"), {
    type: "expense", id: 91, action: "budget_impact", value: "large_oneoff"
  });
  assert.deepEqual(parseExpenseEditorCallback("ee:d:42:m"), {
    type: "draft", id: 42, action: "multi_item_selector"
  });
  assert.deepEqual(parseExpenseEditorCallback("ee:d:42:0:p:1"), {
    type: "draft", id: 42, itemIndex: 0, action: "category_page", page: 1
  });
  assert.deepEqual(parseExpenseEditorCallback("ee:x:91:dm"), {
    type: "expense", id: 91, action: "date_menu"
  });
  assert.deepEqual(parseExpenseEditorCallback("ee:x:91:cancel:8"), {
    type: "expense", id: 91, action: "cancel", sessionId: 8
  });
  assert.equal(parseExpenseEditorCallback("ee:d:42:o"), null);
  assert.equal(parseExpenseEditorCallback("ee:x:not-id:o"), null);
});

test("renders the approved radio states in Russian and English", () => {
  assert.deepEqual(treatmentLabels("regular", "ru"), ["◉ Учесть сегодня", "○ Распределить до конца месяца"]);
  assert.deepEqual(treatmentLabels("large_oneoff", "ru"), ["○ Учесть сегодня", "◉ Распределить до конца месяца"]);
  assert.deepEqual(treatmentLabels("regular", "en"), ["◉ Count today", "○ Spread across remaining days"]);
});

test("renders escaped editor text and compact callback keyboards", () => {
  const text = formatExpenseEditor(draftTarget, { language: "en", timeZone: "Asia/Bangkok" });
  const keyboard = expenseEditorKeyboard(draftTarget, { language: "en" });

  assert.match(text, /coffee &lt;milk&gt;/);
  assert.match(text, /Amount/);
  assert.match(text, /Count today/);
  assert.equal(editorTargetKey(draftTarget), "d:42:0");
  assert.ok(keyboard.inline_keyboard.flat().some((button) => button.callback_data === "ee:d:42:0:dm"));
  assert.ok(keyboard.inline_keyboard.flat().some((button) => button.text === "💾 Save"));
  assert.ok(!keyboard.inline_keyboard.flat().some((button) => button.callback_data?.endsWith(":del")));
  for (const button of keyboard.inline_keyboard.flat()) {
    if (button.callback_data) assert.ok(Buffer.byteLength(button.callback_data, "utf8") <= 64);
  }
});

test("renders localized input, date, treatment, and validation controls", () => {
  assert.match(expenseInputPrompt("amount", { language: "ru" }), /сумм/i);
  assert.match(editorMessageForCode("expense_future_date", "ru"), /ещё не наступило/i);
  assert.match(editorMessageForCode("expense_not_found", "en"), /no longer available/i);

  const dateButtons = expenseDateKeyboard(draftTarget, "en").inline_keyboard.flat();
  assert.ok(dateButtons.some((button) => button.callback_data === "ee:d:42:0:dt:t"));
  const treatmentButtons = expenseTreatmentKeyboard(draftTarget, "en").inline_keyboard.flat();
  assert.deepEqual(treatmentButtons.map((button) => button.text), ["◉ Count today", "○ Spread across remaining days", "← Back"]);

  const categoryButtons = expenseCategoryKeyboard(draftTarget, undefined, { language: "en", page: 1, pageSize: 2 }).inline_keyboard.flat();
  assert.ok(categoryButtons.some((button) => button.callback_data === "ee:d:42:0:p:0"));
  assert.ok(categoryButtons.some((button) => button.callback_data === "ee:d:42:0:p:2"));
});

test("applies a draft editor change to the selected item only", async () => {
  let received;
  const repository = {
    async updateDraftItemForTelegramUser(...args) {
      received = args;
      return {
        id: 42,
        source_text: "coffee 10, lunch 20",
        version: 4,
        items: [
          { amount: 10, currency: "THB", description: "coffee" },
          { amount: 15, currency: "USD", description: "lunch" }
        ]
      };
    }
  };

  const result = await applyDraftEditorChange({
    repository,
    telegramUserId: 100,
    target: { type: "draft", id: 42, itemIndex: 1 },
    field: "amount",
    value: { amount: 15, currency: "USD" },
    expectedVersion: 3,
    now: new Date("2026-07-15T12:00:00.000Z")
  });

  assert.equal(result.target.items[1].amount, 15);
  assert.equal(result.target.items[0].amount, 10);
  assert.equal(result.target.source_text, "coffee 10, lunch 20");
  assert.deepEqual(received, [42, 1, 100, { amount: 15, currency: "USD" }, { expectedVersion: 3 }]);
});

test("validates draft editor field patches before repository mutation", async () => {
  let called = false;
  const repository = { async updateDraftItemForTelegramUser() { called = true; } };
  await assert.rejects(
    () => applyDraftEditorChange({
      repository,
      telegramUserId: 100,
      target: { type: "draft", id: 42, itemIndex: 0 },
      field: "spent_at",
      value: new Date("2026-07-15T12:01:00.000Z"),
      now: new Date("2026-07-15T12:00:00.000Z")
    }),
    { code: "expense_future_date" }
  );
  assert.equal(called, false);
});

test("maps every non-amount draft editor field to the draft item shape", async () => {
  const patches = [];
  const repository = {
    async updateDraftItemForTelegramUser(_id, _index, _telegramUserId, patch) {
      patches.push(patch);
      return { id: 42, items: [{ amount: 10, currency: "THB", ...patch }] };
    }
  };
  const base = {
    repository,
    telegramUserId: 100,
    target: { type: "draft", id: 42, itemIndex: 0 },
    now: new Date("2026-07-15T12:00:00.000Z")
  };

  await applyDraftEditorChange({ ...base, field: "description", value: " Coffee " });
  await applyDraftEditorChange({ ...base, field: "tags", value: ["work", "morning"] });
  await applyDraftEditorChange({ ...base, field: "category", value: "food_cafe" });
  await applyDraftEditorChange({ ...base, field: "spent_at", value: new Date("2026-07-14T12:00:00.000Z") });
  await applyDraftEditorChange({ ...base, field: "budget_impact", value: "large_oneoff" });

  assert.deepEqual(patches, [
    { description: "Coffee" },
    { tags: ["work", "morning"] },
    { category_slug: "food_cafe", category_source: "user", needs_review: false, confidence: 0.9 },
    { spent_at: "2026-07-14T12:00:00.000Z" },
    { budget_impact: "large_oneoff" }
  ]);
});

test("applies saved-expense changes through the shared editor validator", async () => {
  let received;
  const repository = {
    async updateExpenseForTelegramUser(...args) {
      received = args;
      return { id: 91, amount_original: 20, currency_original: "USD" };
    }
  };
  const now = new Date("2026-07-15T12:00:00.000Z");
  const result = await applySavedExpenseEditorChange({
    repository,
    telegramUserId: 100,
    target: { type: "expense", id: 91 },
    field: "amount",
    value: { amount: 20, currency: "USD" },
    now
  });

  assert.equal(result.target.id, 91);
  assert.deepEqual(received, [91, 100, { amount: 20, currency: "USD" }, now, undefined]);
});

test("saved-expense category change keeps only the financial-snapshot-safe patch", async () => {
  let received;
  const repository = {
    async updateExpenseForTelegramUser(...args) {
      received = args;
      return { id: 91, category_slug: "food_cafe" };
    }
  };

  await applySavedExpenseEditorChange({
    repository,
    telegramUserId: 100,
    target: { type: "expense", id: 91 },
    field: "category",
    value: "food_cafe"
  });

  assert.deepEqual(received[2], { category_slug: "food_cafe" });
});
