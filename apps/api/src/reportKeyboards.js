export function weeklyReportKeyboard(miniAppUrl, telegramUserId, period, language = "ru") {
  const text = language === "en"
    ? { open: "Open week" }
    : { open: "Открыть неделю" };
  return {
    inline_keyboard: [[
      webAppButton(text.open, weeklyHistoryUrl(miniAppUrl, telegramUserId, period), "primary")
    ]]
  };
}

export function monthlyReportKeyboard(miniAppUrl, telegramUserId, period, language = "ru") {
  const text = language === "en"
    ? { open: "Open month", budget: "New month budget" }
    : { open: "Открыть месяц", budget: "Бюджет на новый месяц" };
  return {
    inline_keyboard: [[
      webAppButton(text.open, monthlyHistoryUrl(miniAppUrl, telegramUserId, period), "primary"),
      webAppButton(text.budget, `${miniAppUrl}?telegramUserId=${telegramUserId}&view=settings&focus=budget`)
    ]]
  };
}

function weeklyHistoryUrl(miniAppUrl, telegramUserId, period) {
  const url = new URL(miniAppUrl);
  url.searchParams.set("telegramUserId", String(telegramUserId));
  url.searchParams.set("view", "history");
  url.searchParams.set("period", "custom");
  url.searchParams.set("fromDate", period.localStartDate);
  url.searchParams.set("toDate", period.localEndDate);
  url.searchParams.set("launchSource", "report");
  url.searchParams.set("reportType", "weekly");
  url.searchParams.set("reportKey", period.periodKey);
  return url.toString();
}

function monthlyHistoryUrl(miniAppUrl, telegramUserId, period) {
  const url = new URL(miniAppUrl);
  url.searchParams.set("telegramUserId", String(telegramUserId));
  url.searchParams.set("view", "history");
  url.searchParams.set("period", "month");
  url.searchParams.set("monthKey", period.periodKey);
  url.searchParams.set("fromDate", period.localStartDate);
  url.searchParams.set("toDate", period.localEndDate);
  url.searchParams.set("launchSource", "report");
  url.searchParams.set("reportType", "monthly");
  url.searchParams.set("reportKey", period.periodKey);
  return url.toString();
}

function webAppButton(text, url, style) {
  return { text, ...(style ? { style } : {}), web_app: { url } };
}
