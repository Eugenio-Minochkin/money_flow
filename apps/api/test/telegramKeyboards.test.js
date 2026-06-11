import test from "node:test";
import assert from "node:assert/strict";

import { appKeyboard, draftKeyboard } from "../src/telegramKeyboards.js";

test("draft keyboard includes confirm edit cancel inbox and mini app actions", () => {
  const keyboard = draftKeyboard(42, [{
    amount: 70,
    category_slug: "other",
    budget_impact: "planned",
    needs_review: true
  }], "http://localhost:3000", 100);
  const buttons = keyboard.inline_keyboard.flat();

  assert.equal(buttons[0].callback_data, "confirm:42");
  assert.ok(buttons.some((button) => button.callback_data === "cancel:42"));
  assert.ok(buttons.some((button) => button.callback_data === "inbox:42"));
  assert.ok(buttons.some((button) => button.callback_data === "cat:42:0:food_cafe"));
  assert.ok(buttons.some((button) => button.callback_data === "cat:42:0:transport"));
  assert.ok(buttons.some((button) => button.callback_data === "cat:42:0:sport_activities"));
  assert.ok(buttons.some((button) => button.callback_data === "cat:42:0:other"));
  assert.ok(buttons.some((button) => button.callback_data === "impact:42:0:regular"));
  assert.ok(buttons.some((button) => button.callback_data === "impact:42:0:planned"));
  assert.ok(buttons.some((button) => button.callback_data === "impact:42:0:large_oneoff"));
  assert.ok(buttons.some((button) => button.text === "☑️ Плановая"));
  assert.ok(buttons.every((button) => button.text !== "-10" && button.text !== "+10"));
  assert.ok(buttons.some((button) => button.web_app?.url === "http://localhost:3000?telegramUserId=100&draftId=42"));
});

test("app keyboard opens Mini App for the user", () => {
  const keyboard = appKeyboard("http://localhost:3000", 100);

  assert.equal(keyboard.inline_keyboard[0][0].web_app.url, "http://localhost:3000?telegramUserId=100");
});
