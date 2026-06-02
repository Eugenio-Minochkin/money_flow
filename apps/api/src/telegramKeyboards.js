export function draftKeyboard(draftId, items = [], miniAppUrl, telegramUserId) {
  const firstReviewIndex = items.findIndex((item) => item.needs_review || item.category_slug === "other");
  const quickRows = [
    [
      { text: "-10", callback_data: `amount:${draftId}:0:-10` },
      { text: "+10", callback_data: `amount:${draftId}:0:10` }
    ]
  ];
  if (firstReviewIndex >= 0) {
    quickRows.push([
      { text: "Еда", callback_data: `cat:${draftId}:${firstReviewIndex}:food_cafe` },
      { text: "Дом", callback_data: `cat:${draftId}:${firstReviewIndex}:home` },
      { text: "Транспорт", callback_data: `cat:${draftId}:${firstReviewIndex}:transport` }
    ]);
    quickRows.push([
      { text: "Здоровье", callback_data: `cat:${draftId}:${firstReviewIndex}:health` },
      { text: "Спорт", callback_data: `cat:${draftId}:${firstReviewIndex}:sport_activities` },
      { text: "Другое", callback_data: `cat:${draftId}:${firstReviewIndex}:other` }
    ]);
  }
  return {
    inline_keyboard: [
      [{ text: "✅ Подтвердить", callback_data: `confirm:${draftId}` }],
      ...quickRows,
      [
        { text: "✏️ Изменить", web_app: { url: `${miniAppUrl}?telegramUserId=${telegramUserId}&draftId=${draftId}` } },
        { text: "🗑 Отменить", callback_data: `cancel:${draftId}` }
      ],
      [{ text: "📥 Разобрать позже", callback_data: `inbox:${draftId}` }],
      [{ text: "📱 Mini App", web_app: { url: `${miniAppUrl}?telegramUserId=${telegramUserId}` } }]
    ]
  };
}

export function appKeyboard(miniAppUrl, telegramUserId) {
  return {
    inline_keyboard: [[{ text: "📱 Открыть Mini App", web_app: { url: `${miniAppUrl}?telegramUserId=${telegramUserId}` } }]]
  };
}
