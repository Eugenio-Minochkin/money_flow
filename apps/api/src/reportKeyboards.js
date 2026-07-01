export function weeklyReportKeyboard(miniAppUrl, telegramUserId, periodKey, language = "ru") {
  const text = language === "en"
    ? { open: "Open week", add: "Add expense" }
    : { open: "Открыть неделю", add: "Добавить трату" };
  return {
    inline_keyboard: [[
      webAppButton(text.open, reportUrl(miniAppUrl, telegramUserId, "history", "week", periodKey)),
      webAppButton(text.add, `${miniAppUrl}?telegramUserId=${telegramUserId}&action=addExpense`)
    ]]
  };
}

export function monthlyReportKeyboard(miniAppUrl, telegramUserId, periodKey, language = "ru") {
  const text = language === "en"
    ? { open: "Open month", budget: "New month budget" }
    : { open: "Открыть месяц", budget: "Бюджет на новый месяц" };
  return {
    inline_keyboard: [[
      webAppButton(text.open, reportUrl(miniAppUrl, telegramUserId, "history", "month", periodKey)),
      webAppButton(text.budget, `${miniAppUrl}?telegramUserId=${telegramUserId}&view=settings&focus=budget`)
    ]]
  };
}

function reportUrl(miniAppUrl, telegramUserId, view, period, periodKey) {
  return `${miniAppUrl}?telegramUserId=${telegramUserId}&view=${view}&period=${period}&periodKey=${periodKey}`;
}

function webAppButton(text, url) {
  return { text, web_app: { url } };
}
