const QUICK_CATEGORY_CODES = [
  { code: "food", slug: "food_cafe", label: "food" },
  { code: "home", slug: "home", label: "home" },
  { code: "transport", slug: "transport", label: "transport" },
  { code: "health", slug: "health", label: "health" },
  { code: "sport", slug: "sport_activities", label: "sport" },
  { code: "other", slug: "other", label: "other" }
];

export function categorySlugFromCode(code) {
  return QUICK_CATEGORY_CODES.find((entry) => entry.code === code)?.slug ?? null;
}

export function categoryCodeFromSlug(slug) {
  return QUICK_CATEGORY_CODES.find((entry) => entry.slug === slug)?.code ?? null;
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

export function draftKeyboard(draftId, items = [], miniAppUrl, telegramUserId, language = "ru") {
  const text = keyboardText(language);
  const rows = [[{ text: `✅ ${text.confirm}`, callback_data: `d:${draftId}:confirm` }]];

  if (Array.isArray(items) && items.length === 1) {
    const item = items[0];
    const impact = item.budget_impact;
    rows.push([
      typeButton(text.regular, impact === "regular", draftId, "r"),
      typeButton(text.large, impact === "large_oneoff", draftId, "l")
    ]);
    const categoryIsResolved =
      item.category_source === "user" ||
      (item.category_slug !== "other" && !item.needs_review);
    if (!categoryIsResolved) {
      rows.push(QUICK_CATEGORY_CODES.slice(0, 3).map((entry) =>
        categoryButton(text[entry.label], false, draftId, entry.code)));
      rows.push(QUICK_CATEGORY_CODES.slice(3).map((entry) =>
        categoryButton(text[entry.label], false, draftId, entry.code)));
    }
  }

  rows.push([
    { text: `✏️ ${text.edit}`, web_app: { url: `${miniAppUrl}?telegramUserId=${telegramUserId}&draftId=${draftId}` } },
    { text: `🗑 ${text.cancel}`, callback_data: `d:${draftId}:cancel` }
  ]);
  rows.push([{ text: `📥 ${text.later}`, callback_data: `d:${draftId}:review` }]);
  rows.push([{ text: "📱 Mini App", web_app: { url: `${miniAppUrl}?telegramUserId=${telegramUserId}` } }]);
  return { inline_keyboard: rows };
}

function typeButton(label, selected, draftId, code) {
  return { text: `${selected ? "🔘" : "⚪"} ${label}`, callback_data: `d:${draftId}:t:${code}` };
}

function categoryButton(label, selected, draftId, code) {
  return { text: `${selected ? "✅" : "⬜"} ${label}`, callback_data: `d:${draftId}:c:${code}` };
}

export function plannedDraftKeyboard(plannedDraftId, miniAppUrl, telegramUserId, language = "ru") {
  const text = keyboardText(language);
  return {
    inline_keyboard: [
      [{ text: `✅ ${text.addPlanned}`, callback_data: `plan_confirm:${plannedDraftId}` }],
      [
        { text: `✏️ ${text.edit}`, web_app: { url: `${miniAppUrl}?telegramUserId=${telegramUserId}&view=plan` } },
        { text: `🗑 ${text.cancel}`, callback_data: `plan_cancel:${plannedDraftId}` }
      ],
      [{ text: "📱 Mini App", web_app: { url: `${miniAppUrl}?telegramUserId=${telegramUserId}` } }]
    ]
  };
}

export function appKeyboard(miniAppUrl, telegramUserId, language = "ru") {
  const text = keyboardText(language);
  return {
    inline_keyboard: [[{ text: `📱 ${text.openApp}`, web_app: { url: `${miniAppUrl}?telegramUserId=${telegramUserId}` } }]]
  };
}

export function inboxDraftKeyboard(miniAppUrl, telegramUserId, draftId, language = "ru") {
  const text = keyboardText(language);
  return {
    inline_keyboard: [
      [{ text: `📥 ${text.openDraft}`, web_app: { url: `${miniAppUrl}?telegramUserId=${telegramUserId}&draftId=${draftId}` } }],
      [{ text: `📱 ${text.openApp}`, web_app: { url: `${miniAppUrl}?telegramUserId=${telegramUserId}` } }]
    ]
  };
}

export function dailyReminderKeyboard(language = "ru") {
  const text = language === "en"
    ? { add: "Add expense", noSpending: "No spending today", disable: "Don't remind me" }
    : { add: "Добавить расход", noSpending: "Сегодня без трат", disable: "Не напоминать" };
  return {
    inline_keyboard: [
      [{ text: text.add, callback_data: "daily_reminder:add" }],
      [{ text: text.noSpending, callback_data: "daily_reminder:no_spending" }],
      [{ text: text.disable, callback_data: "daily_reminder:disable" }]
    ]
  };
}

function keyboardText(language) {
  if (language === "en") {
    return {
      addPlanned: "Add planned expense",
      cancel: "Cancel",
      confirm: "Confirm",
      edit: "Edit",
      food: "Food",
      health: "Health",
      home: "Home",
      later: "Review later",
      large: "Large",
      openApp: "Open Mini App",
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
    edit: "Изменить",
    food: "Еда",
    health: "Здоровье",
    home: "Дом",
    later: "Разобрать позже",
    large: "Крупная",
    regular: "Обычная",
    openApp: "Открыть Mini App",
    openDraft: "Открыть этот черновик",
    other: "Другое",
    sport: "Спорт",
    transport: "Транспорт"
  };
}
