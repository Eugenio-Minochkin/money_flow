import test from "node:test";
import assert from "node:assert/strict";

import { CATEGORIES } from "../../../packages/shared/src/categories.js";

import {
  appKeyboard,
  budgetTopupDraftKeyboard,
  budgetTopupMiniAppKeyboard,
  budgetTopupSuccessKeyboard,
  budgetTopupUndoKeyboard,
  dailyReminderKeyboard,
  draftKeyboard,
  inboxDraftKeyboard,
  plannedDraftKeyboard,
  savedExpenseKeyboard
} from "../src/telegramKeyboards.js";

test("single-item draft keyboard uses canonical category callbacks", () => {
  const keyboard = draftKeyboard(42, [{
    amount: 70, category_slug: "other", category_source: "parser", needs_review: true, budget_impact: "regular"
  }], "http://localhost:3000", 100, "ru");
  const buttons = keyboard.inline_keyboard.flat();

  assert.equal(buttons[0].callback_data, "d:42:confirm");
  assert.equal(buttons[0].text, "✅ Сохранить");
  assert.ok(buttons.some((b) => b.callback_data === "d:42:cancel"));
  assert.ok(buttons.some((b) => b.callback_data === "d:42:review"));
  assert.ok(buttons.some((b) => b.callback_data === "d:42:t:r"));
  assert.ok(buttons.some((b) => b.callback_data === "d:42:t:l"));
  assert.ok(buttons.some((b) => b.callback_data === "d:42:c:food_cafe"));
  assert.ok(buttons.some((b) => b.callback_data === "d:42:c:other"));
  assert.ok(buttons.every((b) => !/planned/i.test(b.callback_data)));
  assert.ok(buttons.some((b) => b.text === "◉ Учесть сегодня"));
  assert.ok(buttons.some((b) => b.text === "○ Распределить до конца месяца"));
  assert.ok(buttons.some((b) => b.callback_data === "d:42:c:groceries"));
  assert.ok(buttons.every((b) => !b.callback_data?.startsWith("d:42:c:") || !b.text.startsWith("⬜")));
  assert.ok(buttons.some((b) => b.callback_data === "ee:d:42:0:o" && b.text.includes("Исправить")));
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

test("saved expense keyboard keeps editor actions and the final Mini App row", () => {
  const keyboard = savedExpenseKeyboard(91, "http://localhost:3000", 100, "en");

  assert.deepEqual(keyboard.inline_keyboard[0].map((button) => button.callback_data), ["ee:x:91:o", "ee:x:91:del"]);
  assert.equal(keyboard.inline_keyboard.at(-1)[0].text, "📱 Open Mini App");
  assert.equal(keyboard.inline_keyboard.at(-1)[0].web_app.url, "http://localhost:3000?telegramUserId=100");
});

test("daily reminder keyboard uses localized labels, styles, and separate action rows", () => {
  for (const [language, labels] of [["en", ["➕ Add expense", "✅ No spending today", "🔕 Turn off reminders"]], ["ru", ["➕ Добавить расход", "✅ Сегодня без трат", "🔕 Отключить напоминания"]]]) {
    const keyboard = dailyReminderKeyboard(language);
    const buttons = keyboard.inline_keyboard.flat();

    assert.equal(keyboard.inline_keyboard.length, 3);
    assert.ok(keyboard.inline_keyboard.every((row) => row.length === 1));
    assert.deepEqual(buttons.map((button) => button.text), labels);
    assert.deepEqual(buttons.map((button) => button.callback_data), [
      "daily_reminder:add",
      "daily_reminder:no_spending",
      "daily_reminder:disable"
    ]);
    assert.equal(buttons[0].style, "primary");
    assert.equal(buttons[1].style, "success");
    assert.equal("style" in buttons[2], false);
  }
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

test("unresolved single-item draft keyboard offers every canonical category in compact rows", () => {
  const keyboard = draftKeyboard(42, [{
    amount: 70, category_slug: "other", category_source: "parser", needs_review: true, budget_impact: "regular"
  }], "http://localhost:3000", 100, "en");
  const categoryRows = keyboard.inline_keyboard.filter((row) => row.some((button) => button.callback_data?.startsWith("d:42:c:")));
  const categoryButtons = categoryRows.flat();

  assert.equal(keyboard.inline_keyboard[0][0].style, "success");
  assert.deepEqual(categoryButtons.map((button) => button.callback_data), CATEGORIES.map((category) => `d:42:c:${category.slug}`));
  assert.deepEqual(categoryRows.map((row) => row.length), [3, 3, 3, 3, 1]);
  assert.deepEqual(categoryRows.at(-1).map((button) => button.callback_data), ["d:42:c:other"]);
  assert.ok(categoryButtons.every((button) => !button.text.startsWith("\u2B1C")));
});

test("every category has a distinct compact label in Russian and English", () => {
  for (const language of ["ru", "en"]) {
    const buttons = draftKeyboard(42, [{
      amount: 70, category_slug: "other", category_source: "parser", needs_review: true, budget_impact: "regular"
    }], "http://localhost:3000", 100, language).inline_keyboard
      .flat()
      .filter((button) => button.callback_data?.startsWith("d:42:c:"));

    assert.equal(buttons.length, CATEGORIES.length);
    assert.ok(buttons.every((button) => button.text.trim().length > 0));
    assert.equal(new Set(buttons.map((button) => button.text)).size, CATEGORIES.length);
    assert.deepEqual(buttons.map((button) => button.text), language === "ru"
      ? ["🍽 Еда", "🛒 Продукты", "🏠 Дом", "🛵 Транспорт", "❤️ Здоровье", "🏃 Спорт", "🎒 Вещи", "✈️ Поездки", "📡 Подписки", "📚 Учёба", "🎁 Подарки", "🎭 Досуг", "••• Другое"]
      : ["🍽 Food", "🛒 Groceries", "🏠 Home", "🛵 Transport", "❤️ Health", "🏃 Sport", "🎒 Gear", "✈️ Travel", "📡 Subs", "📚 Study", "🎁 Gifts", "🎭 Leisure", "••• Other"]);
  }
});

test("common Mini App home buttons use one localized label", () => {
  for (const [language, label] of [["ru", "📱 Открыть Mini App"], ["en", "📱 Open Mini App"]]) {
    const keyboards = [
      appKeyboard("http://localhost:3000", 100, language),
      draftKeyboard(42, [], "http://localhost:3000", 100, language),
      plannedDraftKeyboard(42, "http://localhost:3000", 100, language),
      savedExpenseKeyboard(91, "http://localhost:3000", 100, language),
      inboxDraftKeyboard("http://localhost:3000", 100, 42, language),
      budgetTopupSuccessKeyboard(99, "http://localhost:3000", 100, language),
      budgetTopupMiniAppKeyboard("http://localhost:3000", 100, language)
    ];
    for (const keyboard of keyboards) {
      const homeButton = keyboard.inline_keyboard.flat().find((button) => button.web_app?.url === "http://localhost:3000?telegramUserId=100");
      assert.equal(homeButton?.text, label);
      assert.equal(homeButton?.style, "primary");
    }
  }
});

test("legacy category codes and canonical slugs resolve to known categories", async () => {
  const { categorySlugFromCode } = await import("../src/telegramKeyboards.js");

  assert.equal(categorySlugFromCode("food"), "food_cafe");
  assert.equal(categorySlugFromCode("sport"), "sport_activities");
  for (const category of CATEGORIES) {
    assert.equal(categorySlugFromCode(category.slug), category.slug);
  }
  assert.equal(categorySlugFromCode("not_a_category"), null);
});

test("every Mini App button is primary", () => {
  const keyboards = [
    appKeyboard("http://localhost:3000", 100),
    draftKeyboard(42, [], "http://localhost:3000", 100),
    plannedDraftKeyboard(42, "http://localhost:3000", 100),
    savedExpenseKeyboard(91, "http://localhost:3000", 100),
    inboxDraftKeyboard("http://localhost:3000", 100, 42),
    budgetTopupSuccessKeyboard(99, "http://localhost:3000", 100),
    budgetTopupMiniAppKeyboard("http://localhost:3000", 100)
  ];

  for (const button of keyboards.flatMap((keyboard) => keyboard.inline_keyboard.flat())) {
    if (button.web_app) assert.equal(button.style, "primary", button.text);
  }
});

test("parser-fallback other renders every canonical category without checkbox prefixes", () => {
  const keyboard = draftKeyboard(42, [{
    amount: 70, category_slug: "other", category_source: "parser", needs_review: true, budget_impact: "regular"
  }], "http://x", 100, "en");
  const categoryButtons = keyboard.inline_keyboard
    .flat()
    .filter((b) => typeof b.callback_data === "string" && b.callback_data.startsWith("d:42:c:"));
  assert.equal(categoryButtons.length, CATEGORIES.length);
  assert.ok(categoryButtons.every((b) => !b.text.startsWith("⬜")), "category labels should stay compact");
  const other = categoryButtons.find((b) => b.callback_data === "d:42:c:other");
  assert.ok(other);
});

test("planned reminder keyboards use exact occurrence callbacks and explicit terminology", async () => {
  const {
    plannedPaymentReminderKeyboard,
    plannedPaymentDisableConfirmationKeyboard,
    plannedPaymentSuccessKeyboard
  } = await import("../src/telegramKeyboards.js");

  const ru = plannedPaymentReminderKeyboard(42, "2026-07-27", "http://localhost:3000", 100, "ru");
  const en = plannedPaymentReminderKeyboard(42, "2026-07-27", "http://localhost:3000", 100, "en");
  const confirmation = plannedPaymentDisableConfirmationKeyboard(42, "2026-07-27", "ru");
  const success = plannedPaymentSuccessKeyboard("http://localhost:3000", 100, "ru");

  assert.deepEqual(ru.inline_keyboard.map((row) => row[0].text), [
    "✅ Оплачено",
    "⏰ Напомнить завтра",
    "🔕 Отключить плановую оплату",
    "📱 Открыть Mini App"
  ]);
  assert.deepEqual(en.inline_keyboard.map((row) => row[0].text), [
    "✅ Paid",
    "⏰ Remind me tomorrow",
    "🔕 Disable planned payment",
    "📱 Open Mini App"
  ]);
  assert.equal(ru.inline_keyboard[0][0].style, "success");
  assert.equal(ru.inline_keyboard[3][0].style, "primary");
  assert.equal(ru.inline_keyboard[0][0].callback_data, "ppr:p:42:20260727");
  assert.equal(confirmation.inline_keyboard[0][0].callback_data, "ppr:y:42:20260727");
  assert.deepEqual(success.inline_keyboard.map((row) => row[0].text), ["📱 Открыть Mini App"]);
  assert.equal(success.inline_keyboard[0][0].style, "primary");
});
