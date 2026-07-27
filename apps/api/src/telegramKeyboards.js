import { treatmentLabels } from "./telegramExpenseEditor.js";
import { CATEGORIES } from "../../../packages/shared/src/categories.js";
import { draftNeedsCategoryChoice } from "./draftCategory.js";
import { miniAppHomeButton, webAppButton } from "./telegramWebAppButtons.js";

const LEGACY_CATEGORY_CODES = {
  food: "food_cafe",
  sport: "sport_activities"
};

const CATEGORY_BUTTON_LABELS = {
  food_cafe: { ru: "🍽 Еда", en: "🍽 Food" },
  groceries: { ru: "🛒 Продукты", en: "🛒 Groceries" },
  home: { ru: "🏠 Дом", en: "🏠 Home" },
  transport: { ru: "🛵 Транспорт", en: "🛵 Transport" },
  health: { ru: "❤️ Здоровье", en: "❤️ Health" },
  sport_activities: { ru: "🏃 Спорт", en: "🏃 Sport" },
  gear: { ru: "🎒 Вещи", en: "🎒 Gear" },
  travel: { ru: "✈️ Поездки", en: "✈️ Travel" },
  subscriptions: { ru: "📡 Подписки", en: "📡 Subs" },
  education: { ru: "📚 Учёба", en: "📚 Study" },
  gifts_help: { ru: "🎁 Подарки", en: "🎁 Gifts" },
  entertainment: { ru: "🎭 Досуг", en: "🎭 Leisure" },
  other: { ru: "••• Другое", en: "••• Other" }
};

export function categorySlugFromCode(code) {
  if (CATEGORIES.some((category) => category.slug === code)) return code;
  return LEGACY_CATEGORY_CODES[code] ?? null;
}

export function categoryCodeFromSlug(slug) {
  return Object.entries(LEGACY_CATEGORY_CODES).find(([, legacySlug]) => legacySlug === slug)?.[0]
    ?? (CATEGORIES.some((category) => category.slug === slug) ? slug : null);
}

export function parseDraftCallback(data) {
  const parts = String(data ?? "").split(":");
  if (parts[0] !== "d") return null;
  const draftId = parts[1];
  const sub = parts[2];
  if (sub === "confirm" || sub === "cancel" || sub === "review") {
    return { scheme: "d", draftId, action: sub };
  }
  if (sub === "t") return { scheme: "d", draftId, action: "type", value: parts[3] };
  if (sub === "c") return { scheme: "d", draftId, action: "category", value: parts[3] };
  return null;
}

export function parseBudgetTopupCallback(data) {
  const parts = String(data ?? "").split(":");
  if (parts[0] !== "bt") return null;
  const id = parts[1];
  const action = parts[2];
  if (action === "confirm" || action === "cancel" || action === "undo") {
    return { scheme: "bt", id, action };
  }
  return null;
}

export function budgetTopupDraftKeyboard(draftId, language = "ru", options = {}) {
  const text = keyboardText(language);
  const topupConfirm = text.budgetTopupConfirm ?? "\u2705 Добавить к бюджету";
  const topupConfirmLarge = text.budgetTopupConfirmLarge ?? "\u2705 Да, добавить";
  const topupIgnore = text.budgetTopupIgnore ?? "\ud83d\udeab Не учитывать";
  const topupCancel = text.budgetTopupCancel ?? "\ud83d\uddd1 Отменить";
  const rows = [
    [{ text: options.large ? topupConfirmLarge : topupConfirm, callback_data: `bt:${draftId}:confirm` }]
  ];
  if (!options.large) rows.push([{ text: topupIgnore, callback_data: `bt:${draftId}:cancel` }]);
  rows.push([{ text: topupCancel, callback_data: `bt:${draftId}:cancel` }]);
  return { inline_keyboard: rows };
}

export function budgetTopupUndoKeyboard(topupId, language = "ru") {
  const text = keyboardText(language);
  const topupUndo = text.budgetTopupUndo ?? "\u21a9\ufe0f Отменить пополнение";
  return {
    inline_keyboard: [[{ text: topupUndo, callback_data: `bt:${topupId}:undo` }]]
  };
}

export function budgetTopupSuccessKeyboard(topupId, miniAppUrl, telegramUserId, language = "ru") {
  const rows = budgetTopupUndoKeyboard(topupId, language).inline_keyboard;
  rows.push([miniAppHomeButton({ miniAppUrl, telegramUserId, language })]);
  return { inline_keyboard: rows };
}

export function budgetTopupMiniAppKeyboard(miniAppUrl, telegramUserId, language = "ru") {
  return { inline_keyboard: [[miniAppHomeButton({ miniAppUrl, telegramUserId, language })]] };
}

export function draftKeyboard(draftId, items = [], miniAppUrl, telegramUserId, language = "ru") {
  const text = keyboardText(language);
  const rows = [[{ text: `✅ ${text.draftSave ?? text.confirm}`, callback_data: `d:${draftId}:confirm` }]];

  rows[0][0].style = "success";

  if (Array.isArray(items) && items.length === 1) {
    const item = items[0];
    const impact = item.budget_impact;
    const [regularLabel, largeLabel] = treatmentLabels(impact, language);
    rows.push([
      typeButton(regularLabel, draftId, "r"),
      typeButton(largeLabel, draftId, "l")
    ]);
    if (draftNeedsCategoryChoice(item)) {
      const categories = CATEGORIES.filter((category) => category.slug !== "other");
      for (let index = 0; index < categories.length; index += 3) {
        rows.push(categories.slice(index, index + 3).map((category) =>
          categoryButton(categoryButtonLabel(category.slug, language), draftId, category.slug)));
      }
      const other = CATEGORIES.find((category) => category.slug === "other");
      if (other) rows.push([categoryButton(categoryButtonLabel(other.slug, language), draftId, other.slug)]);
    }
  }

  rows.push([
    { text: `✏️ ${text.editorEdit ?? text.edit}`, callback_data: items.length === 1 ? `ee:d:${draftId}:0:o` : `ee:d:${draftId}:m` },
    { text: `🗑 ${text.cancel}`, callback_data: `d:${draftId}:cancel` }
  ]);
  rows.push([{ text: `📥 ${text.later}`, callback_data: `d:${draftId}:review` }]);
  rows.push([miniAppHomeButton({ miniAppUrl, telegramUserId, language })]);
  return { inline_keyboard: rows };
}

function typeButton(label, draftId, code) {
  return { text: label, callback_data: `d:${draftId}:t:${code}` };
}

function categoryButton(label, draftId, slug) {
  return { text: label, callback_data: `d:${draftId}:c:${slug}` };
}

function categoryButtonLabel(slug, language) {
  return CATEGORY_BUTTON_LABELS[slug]?.[language] ?? CATEGORY_BUTTON_LABELS.other[language];
}

export function plannedDraftKeyboard(plannedDraftId, miniAppUrl, telegramUserId, language = "ru") {
  const text = keyboardText(language);
  return {
    inline_keyboard: [
      [{ text: `✅ ${text.addPlanned}`, callback_data: `plan_confirm:${plannedDraftId}` }],
      [
        webAppButton({ text: `✏️ ${text.edit}`, url: `${miniAppUrl}?telegramUserId=${telegramUserId}&view=plan` }),
        { text: `🗑 ${text.cancel}`, callback_data: `plan_cancel:${plannedDraftId}` }
      ],
      [miniAppHomeButton({ miniAppUrl, telegramUserId, language })]
    ]
  };
}

export function appKeyboard(miniAppUrl, telegramUserId, language = "ru") {
  return { inline_keyboard: [[miniAppHomeButton({ miniAppUrl, telegramUserId, language })]] };
}

export function savedExpenseKeyboard(expenseId, miniAppUrl, telegramUserId, language = "ru") {
  const text = keyboardText(language);
  return {
    inline_keyboard: [
      [
        { text: `✏️ ${text.editorEdit ?? text.edit}`, callback_data: `ee:x:${expenseId}:o` },
        { text: `🗑 ${text.deleteExpense ?? text.cancel}`, callback_data: `ee:x:${expenseId}:del` }
      ],
      [miniAppHomeButton({ miniAppUrl, telegramUserId, language })]
    ]
  };
}

export function inboxDraftKeyboard(miniAppUrl, telegramUserId, draftId, language = "ru") {
  const text = keyboardText(language);
  return {
    inline_keyboard: [
      [webAppButton({ text: `📥 ${text.openDraft}`, url: `${miniAppUrl}?telegramUserId=${telegramUserId}&draftId=${draftId}` })],
      [miniAppHomeButton({ miniAppUrl, telegramUserId, language })]
    ]
  };
}

export function dailyReminderKeyboard(language = "ru") {
  const text = language === "en"
    ? { add: "➕ Add expense", noSpending: "✅ No spending today", disable: "🔕 Turn off reminders" }
    : { add: "➕ Добавить расход", noSpending: "✅ Сегодня без трат", disable: "🔕 Отключить напоминания" };
  return {
    inline_keyboard: [
      [{ text: text.add, callback_data: "daily_reminder:add", style: "primary" }],
      [{ text: text.noSpending, callback_data: "daily_reminder:no_spending", style: "success" }],
      [{ text: text.disable, callback_data: "daily_reminder:disable" }]
    ]
  };
}

function keyboardText(language) {
  if (language === "en") {
    return {
      addPlanned: "Add planned expense",
      budgetTopupCancel: "\ud83d\uddd1 Cancel",
      budgetTopupConfirm: "\u2705 Add to budget",
      budgetTopupConfirmLarge: "\u2705 Yes, add it",
      budgetTopupIgnore: "\ud83d\udeab Do not count",
      budgetTopupUndo: "\u21a9\ufe0f Undo top-up",
      cancel: "Cancel",
      confirm: "Confirm",
      draftSave: "Save",
      deleteExpense: "Delete",
      edit: "Edit",
      editorEdit: "Edit",
      food: "Food",
      health: "Health",
      home: "Home",
      later: "Review later",
      large: "Large",
      openDraft: "Open this draft",
      other: "Other",
      planned: "Planned",
      regular: "Regular",
      sport: "Sport",
      transport: "Transport"
    };
  }
  return {
    addPlanned: "Добавить плановую",
    cancel: "Отменить",
    confirm: "Подтвердить",
    draftSave: "Сохранить",
    deleteExpense: "Удалить",
    edit: "Изменить",
    editorEdit: "Исправить",
    food: "Еда",
    health: "Здоровье",
    home: "Дом",
    later: "Разобрать позже",
    large: "Крупная",
    regular: "Обычная",
    openDraft: "Открыть этот черновик",
    other: "Другое",
    sport: "Спорт",
    transport: "Транспорт"
  };
}
