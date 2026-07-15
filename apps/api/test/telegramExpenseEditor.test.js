import test from "node:test";
import assert from "node:assert/strict";

import {
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
