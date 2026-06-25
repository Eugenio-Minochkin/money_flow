import test from "node:test";
import assert from "node:assert/strict";

import { appKeyboard, dailyReminderKeyboard, draftKeyboard } from "../src/telegramKeyboards.js";

test("single-item draft keyboard uses d: scheme, radio type and checkbox category, no planned", () => {
  const keyboard = draftKeyboard(42, [{
    amount: 70, category_slug: "food_cafe", budget_impact: "regular", needs_review: false
  }], "http://localhost:3000", 100, "ru");
  const buttons = keyboard.inline_keyboard.flat();

  assert.equal(buttons[0].callback_data, "d:42:confirm");
  assert.ok(buttons.some((b) => b.callback_data === "d:42:cancel"));
  assert.ok(buttons.some((b) => b.callback_data === "d:42:review"));
  assert.ok(buttons.some((b) => b.callback_data === "d:42:t:r"));
  assert.ok(buttons.some((b) => b.callback_data === "d:42:t:l"));
  assert.ok(buttons.some((b) => b.callback_data === "d:42:c:food"));
  assert.ok(buttons.some((b) => b.callback_data === "d:42:c:other"));
  assert.ok(buttons.every((b) => !/planned/i.test(b.callback_data)));
  assert.ok(buttons.some((b) => b.text.startsWith("🔘")));
  assert.ok(buttons.some((b) => b.text.startsWith("⚪")));
  assert.ok(buttons.some((b) => b.text.startsWith("✅") && b.text.includes("Еда")));
  assert.ok(buttons.some((b) => b.text.startsWith("⬜")));
  assert.ok(buttons.some((b) => b.text.includes("Обычная")));
  assert.ok(buttons.some((b) => b.text.includes("Крупная")));
  assert.ok(buttons.some((b) => b.web_app?.url === "http://localhost:3000?telegramUserId=100&draftId=42"));
});

test("multi-item draft keyboard omits type and category rows", () => {
  const keyboard = draftKeyboard(42, [
    { amount: 70, category_slug: "food_cafe", budget_impact: "regular", needs_review: false },
    { amount: 90, category_slug: "transport", budget_impact: "regular", needs_review: false }
  ], "http://localhost:3000", 100, "en");
  const buttons = keyboard.inline_keyboard.flat();
  assert.ok(buttons.every((b) => !b.callback_data?.startsWith("d:42:t:")));
  assert.ok(buttons.every((b) => !b.callback_data?.startsWith("d:42:c:")));
  assert.ok(buttons.some((b) => b.callback_data === "d:42:confirm"));
});

test("app keyboard opens Mini App for the user", () => {
  const keyboard = appKeyboard("http://localhost:3000", 100);

  assert.equal(keyboard.inline_keyboard[0][0].web_app.url, "http://localhost:3000?telegramUserId=100");
});

test("daily reminder keyboard includes lean MVP actions", () => {
  const keyboard = dailyReminderKeyboard("en");
  const buttons = keyboard.inline_keyboard.flat();

  assert.equal(buttons[0].callback_data, "daily_reminder:add");
  assert.equal(buttons[1].callback_data, "daily_reminder:no_spending");
  assert.equal(buttons[2].callback_data, "daily_reminder:disable");
  assert.equal(buttons[0].text, "Add expense");
});
