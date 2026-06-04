export function draftKeyboard(draftId, items = [], miniAppUrl, telegramUserId, language = "ru") {
  const text = keyboardText(language);
  const firstReviewIndex = items.findIndex((item) => item.needs_review || item.category_slug === "other");
  const quickRows = [
    [
      { text: "-10", callback_data: `amount:${draftId}:0:-10` },
      { text: "+10", callback_data: `amount:${draftId}:0:10` }
    ]
  ];
  if (firstReviewIndex >= 0) {
    quickRows.push([
      { text: text.food, callback_data: `cat:${draftId}:${firstReviewIndex}:food_cafe` },
      { text: text.home, callback_data: `cat:${draftId}:${firstReviewIndex}:home` },
      { text: text.transport, callback_data: `cat:${draftId}:${firstReviewIndex}:transport` }
    ]);
    quickRows.push([
      { text: text.health, callback_data: `cat:${draftId}:${firstReviewIndex}:health` },
      { text: text.sport, callback_data: `cat:${draftId}:${firstReviewIndex}:sport_activities` },
      { text: text.other, callback_data: `cat:${draftId}:${firstReviewIndex}:other` }
    ]);
  }
  return {
    inline_keyboard: [
      [{ text: `✅ ${text.confirm}`, callback_data: `confirm:${draftId}` }],
      ...quickRows,
      [
        { text: `✏️ ${text.edit}`, web_app: { url: `${miniAppUrl}?telegramUserId=${telegramUserId}&draftId=${draftId}` } },
        { text: `🗑 ${text.cancel}`, callback_data: `cancel:${draftId}` }
      ],
      [{ text: `📥 ${text.later}`, callback_data: `inbox:${draftId}` }],
      [{ text: "📱 Mini App", web_app: { url: `${miniAppUrl}?telegramUserId=${telegramUserId}` } }]
    ]
  };
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
      openApp: "Open Mini App",
      other: "Other",
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
    openApp: "Открыть Mini App",
    other: "Другое",
    sport: "Спорт",
    transport: "Транспорт"
  };
}
