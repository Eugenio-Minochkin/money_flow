import test from "node:test";
import assert from "node:assert/strict";

import {
  appKeyboard,
  budgetTopupDraftKeyboard,
  budgetTopupMiniAppKeyboard,
  budgetTopupSuccessKeyboard,
  budgetTopupUndoKeyboard,
  dailyReminderKeyboard,
  draftKeyboard
} from "../src/telegramKeyboards.js";

test("single-item draft keyboard uses d: scheme, radio type and checkbox category, no planned", () => {
  const keyboard = draftKeyboard(42, [{
    amount: 70, category_slug: "other", category_source: "parser", needs_review: true, budget_impact: "regular"
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
  assert.ok(buttons.some((b) => b.text.startsWith("⬜") && b.text.includes("Еда")));
  assert.ok(buttons.some((b) => b.text.startsWith("⬜")));
  assert.ok(buttons.some((b) => b.text.includes("Обычная")));
  assert.ok(buttons.some((b) => b.text.includes("Крупная")));
  assert.ok(buttons.some((b) => b.web_app?.url === "http://localhost:3000?telegramUserId=100&draftId=42"));
});

test("resolved confident category hides the category quick buttons", () => {
  const keyboard = draftKeyboard(42, [{ amount: 70, category_slug: "food_cafe", category_source: "parser", needs_review: false, budget_impact: "regular" }], "http://x", 100, "en");
  const buttons = keyboard.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.callback_data === "d:42:t:r"));
  assert.ok(buttons.some((b) => b.callback_data === "d:42:t:l"));
  assert.ok(buttons.every((b) => !b.callback_data?.startsWith("d:42:c:")));
  assert.ok(buttons.some((b) => b.callback_data === "d:42:confirm"));
});

test("user-selected category hides the category quick buttons", () => {
  const keyboard = draftKeyboard(42, [{ amount: 70, category_slug: "other", category_source: "user", needs_review: false, budget_impact: "regular" }], "http://x", 100, "en");
  const buttons = keyboard.inline_keyboard.flat();
  assert.ok(buttons.every((b) => !b.callback_data?.startsWith("d:42:c:")));
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

test("all draft keyboard callback_data are at most 64 bytes", () => {
  for (const id of [1, 42, 9999999]) {
    const keyboard = draftKeyboard(id, [{ amount: 70, category_slug: "food_cafe", budget_impact: "regular", needs_review: false }], "http://x", 100, "en");
    for (const row of keyboard.inline_keyboard) {
      for (const button of row) {
        if (button.callback_data) {
          assert.ok(Buffer.byteLength(button.callback_data, "utf8") <= 64, `too long: ${button.callback_data}`);
        }
      }
    }
  }
});

test("parseDraftCallback decodes d: actions", async () => {
  const { parseDraftCallback } = await import("../src/telegramKeyboards.js");
  assert.deepEqual(parseDraftCallback("d:42:confirm"), { scheme: "d", draftId: "42", action: "confirm" });
  assert.deepEqual(parseDraftCallback("d:42:t:r"), { scheme: "d", draftId: "42", action: "type", value: "r" });
  assert.deepEqual(parseDraftCallback("d:42:c:food"), { scheme: "d", draftId: "42", action: "category", value: "food" });
  assert.deepEqual(parseDraftCallback("d:42:review"), { scheme: "d", draftId: "42", action: "review" });
  assert.equal(parseDraftCallback("confirm:42"), null);
});

test("budget top-up callbacks and keyboards use bt scheme", async () => {
  const { parseBudgetTopupCallback } = await import("../src/telegramKeyboards.js");
  assert.deepEqual(parseBudgetTopupCallback("bt:42:confirm"), { scheme: "bt", id: "42", action: "confirm" });
  assert.deepEqual(parseBudgetTopupCallback("bt:42:cancel"), { scheme: "bt", id: "42", action: "cancel" });
  assert.deepEqual(parseBudgetTopupCallback("bt:99:undo"), { scheme: "bt", id: "99", action: "undo" });
  assert.equal(parseBudgetTopupCallback("d:42:confirm"), null);

  const draftButtons = budgetTopupDraftKeyboard(42, "en").inline_keyboard.flat();
  assert.ok(draftButtons.some((button) => button.callback_data === "bt:42:confirm" && button.text === "\u2705 Add to budget"));
  assert.ok(draftButtons.some((button) => button.callback_data === "bt:42:cancel" && button.text === "\ud83d\uddd1 Cancel"));
  assert.ok(draftButtons.some((button) => button.callback_data === "bt:42:cancel" && button.text === "\ud83d\udeab Do not count"));

  const undoButtons = budgetTopupUndoKeyboard(99, "en").inline_keyboard.flat();
  assert.equal(undoButtons[0].callback_data, "bt:99:undo");
  assert.equal(undoButtons[0].text, "\u21a9\ufe0f Undo top-up");
});

test("large budget top-up draft keyboard only offers confirm and cancel", () => {
  const keyboard = budgetTopupDraftKeyboard(42, "en", { large: true });
  const buttons = keyboard.inline_keyboard.flat();

  assert.deepEqual(buttons.map((button) => button.callback_data), ["bt:42:confirm", "bt:42:cancel"]);
  assert.equal(buttons[0].text, "\u2705 Yes, add it");
  assert.equal(buttons[1].text, "\ud83d\uddd1 Cancel");
});

test("budget top-up success and terminal keyboards include Mini App buttons", () => {
  const success = budgetTopupSuccessKeyboard(99, "http://localhost:3000", 100, "en");
  assert.equal(success.inline_keyboard[0][0].callback_data, "bt:99:undo");
  assert.equal(success.inline_keyboard[0][0].text, "\u21a9\ufe0f Undo top-up");
  assert.equal(success.inline_keyboard[1][0].text, "\ud83d\udcf1 Open Mini App");
  assert.equal(success.inline_keyboard[1][0].web_app.url, "http://localhost:3000?telegramUserId=100");

  const miniAppOnly = budgetTopupMiniAppKeyboard("http://localhost:3000", 100, "en");
  assert.equal(miniAppOnly.inline_keyboard.length, 1);
  assert.equal(miniAppOnly.inline_keyboard[0][0].text, "\ud83d\udcf1 Open Mini App");
  assert.equal(miniAppOnly.inline_keyboard[0][0].web_app.url, "http://localhost:3000?telegramUserId=100");
});

test("every quick category code round-trips to a known slug", async () => {
  const { categorySlugFromCode, categoryCodeFromSlug } = await import("../src/telegramKeyboards.js");
  for (const code of ["food", "home", "transport", "health", "sport", "other"]) {
    const slug = categorySlugFromCode(code);
    assert.ok(slug, `missing slug for ${code}`);
    assert.equal(categoryCodeFromSlug(slug), code);
  }
});

test("parser-fallback other renders every category button unchecked", () => {
  const keyboard = draftKeyboard(42, [{
    amount: 70, category_slug: "other", category_source: "parser", needs_review: true, budget_impact: "regular"
  }], "http://x", 100, "en");
  const categoryButtons = keyboard.inline_keyboard
    .flat()
    .filter((b) => typeof b.callback_data === "string" && b.callback_data.startsWith("d:42:c:"));
  assert.equal(categoryButtons.length, 6);
  assert.ok(categoryButtons.every((b) => b.text.startsWith("⬜")), "no category should be selected for parser-fallback other");
  const other = categoryButtons.find((b) => b.callback_data === "d:42:c:other");
  assert.ok(other && other.text.startsWith("⬜"));
});
