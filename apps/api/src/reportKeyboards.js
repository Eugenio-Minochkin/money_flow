export function weeklyReportKeyboard(miniAppUrl, telegramUserId, periodKey, language = "ru") {
  const text = language === "en"
    ? { open: "Open week", add: "Add expense" }
    : { open: "Открыть неделю", add: "Добавить трату" };
  return {
    inline_keyboard: [[
      webAppButton(text.open, reportUrl(miniAppUrl, telegramUserId, "history", "week", "weekly", periodKey)),
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
      webAppButton(text.open, reportUrl(miniAppUrl, telegramUserId, "history", "month", "monthly", periodKey)),
      webAppButton(text.budget, `${miniAppUrl}?telegramUserId=${telegramUserId}&view=settings&focus=budget`)
    ]]
  };
}

function reportUrl(miniAppUrl, telegramUserId, view, period, reportType, reportKey) {
  const url = new URL(miniAppUrl);
  url.searchParams.set("telegramUserId", String(telegramUserId));
  url.searchParams.set("view", view);
  url.searchParams.set("period", period);
  url.searchParams.set("periodKey", reportKey);
  url.searchParams.set("launchSource", "report");
  url.searchParams.set("reportType", reportType);
  url.searchParams.set("reportKey", reportKey);
  return url.toString();
}

function webAppButton(text, url) {
  return { text, web_app: { url } };
}
