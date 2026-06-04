import { categoryName } from "../../../packages/shared/src/categories.js";

export function formatDraft(expenses, options = {}) {
  const language = normalizeLanguage(options.language);
  const totalCurrency = expenses.every((expense) => expense.currency === expenses[0]?.currency)
    ? expenses[0]?.currency
    : (options.baseCurrency ?? "THB");
  const lines = expenses.map((expense, index) =>
    `${index + 1}. <b>${escapeHtml(categoryName(expense.category_slug))}</b>\n   🗓 ${formatSpentAt(expense.spent_at, language)}\n   ${escapeHtml(expense.description)} · <b>${formatMoney(expense.amount, expense.currency, language)}</b>`
  );
  const total = expenses.reduce((sum, expense) => sum + Number(expense.amount), 0);
  const review = expenses.some((expense) => expense.needs_review)
    ? `\n\n⚠️ ${t(language, "draftReview")}`
    : "";
  return [
    `🧾 <b>${t(language, "draftTitle")}</b>`,
    "",
    lines.join("\n\n"),
    "",
    `<b>${t(language, "total")}:</b> ${formatMoney(total, totalCurrency, language)}.${review}`,
    "",
    t(language, "isCorrect")
  ].join("\n");
}

export function formatSavedSummary(total, snapshot, options = {}) {
  const language = normalizeLanguage(options.language);
  const currency = snapshot.baseCurrency ?? "THB";
  const progress = snapshot.budgetProgressPercent == null ? "" : ` (${formatAmount(snapshot.budgetProgressPercent, language)}%)`;
  const planDeviation = Number(snapshot.planDeviation ?? 0);
  const planLine = planDeviation > 0
    ? `⚠️ <b>${t(language, "plan")}:</b> ${t(language, "aboveBy")} ${formatMoney(Math.abs(planDeviation), currency, language)}`
    : `🟢 <b>${t(language, "plan")}:</b> ${t(language, "belowBy")} ${formatMoney(Math.abs(planDeviation), currency, language)}`;
  const recovery = formatRecoveryAdvice(snapshot, language);

  return [
    `✅ <b>${t(language, "savedExpense")}</b>`,
    `<b>${formatMoney(total, currency, language)}</b>`,
    "",
    `<b>${t(language, "now")}</b>`,
    `📌 <b>${t(language, "today")}:</b> ${formatAmount(snapshot.today, language)} / ${formatMoney(snapshot.dayPlanLimit ?? snapshot.dailyPlanLimit, currency, language)}`,
    `⚡️ <b>${t(language, "safeToday")}:</b> ${formatMoney(snapshot.dayRemaining ?? snapshot.safeToSpendPerDay, currency, language)}`,
    `📆 <b>${t(language, "week")}:</b> ${formatAmount(snapshot.week, language)} / ${formatMoney(snapshot.weekPlanLimit ?? snapshot.weeklyBudget, currency, language)}`,
    "",
    `<b>${t(language, "month")}</b>`,
    `📅 <b>${t(language, "spent")}:</b> ${formatAmount(snapshot.month, language)} / ${formatMoney(snapshot.monthlyBudget, currency, language)}${progress}`,
    `🟢 <b>${t(language, "free")}:</b> ${formatMoney(snapshot.freeRemaining, currency, language)}`,
    `🧾 <b>${t(language, "planned")}:</b> ${formatMoney(snapshot.plannedRemaining, currency, language)}`,
    `🔮 <b>${t(language, "forecast")}:</b> ${formatMoney(snapshot.forecastMonthTotal ?? 0, currency, language)}`,
    planLine,
    recovery ? `\n${recovery}` : "",
    "",
    `⚡️ <b>${t(language, "safeToSpend")}:</b> ${formatMoney(snapshot.safeToSpendPerDay, currency, language)}/${t(language, "day")}`,
    t(language, "withPlanned")
  ].join("\n");
}

function formatRecoveryAdvice(snapshot, language) {
  const advice = snapshot.recoveryAdvice;
  if (!advice?.active) return "";
  const currency = snapshot.baseCurrency ?? "THB";
  const icon = advice.state === "danger" ? "🚨" : "⚠️";
  return [
    `${icon} <b>${t(language, "returnToBudget")}:</b> ${t(language, "forecastAboveBudget")} ${formatMoney(advice.forecastOverBudget, currency, language)}`,
    `${t(language, "holdPace")} <b>${formatMoney(advice.requiredPerDay, currency, language)}/${t(language, "day")}</b>.`
  ].join("\n");
}

export function formatTotals(command, snapshot, options = {}) {
  const language = normalizeLanguage(options.language);
  const currency = snapshot.baseCurrency ?? "THB";
  if (command === "/today") {
    return [
      `📌 <b>${t(language, "today")}:</b> ${formatMoney(snapshot.today, currency, language)}`,
      `⚡️ <b>${t(language, "safeToSpend")}:</b> ${formatMoney(snapshot.safeToSpendPerDay, currency, language)}/${t(language, "day")}`
    ].join("\n");
  }
  if (command === "/week") return `📆 <b>${t(language, "week")}:</b> ${formatMoney(snapshot.week, currency, language)}`;
  if (command === "/month") {
    const progress = snapshot.budgetProgressPercent == null ? "" : ` (${formatAmount(snapshot.budgetProgressPercent, language)}%)`;
    return [
      `📅 <b>${t(language, "month")}:</b> ${formatAmount(snapshot.month, language)} / ${formatMoney(snapshot.monthlyBudget, currency, language)}${progress}`,
      `🔮 <b>${t(language, "forecast")}:</b> ${formatMoney(snapshot.forecastMonthTotal ?? 0, currency, language)}`
    ].join("\n");
  }
  return [
    `💰 <b>${t(language, "budget")}:</b> ${formatMoney(snapshot.monthlyBudget, currency, language)}`,
    `📅 <b>${t(language, "month")}:</b> ${formatMoney(snapshot.month, currency, language)}`,
    `🧾 <b>${t(language, "planned")}:</b> ${formatMoney(snapshot.plannedRemaining, currency, language)}`,
    `🟢 <b>${t(language, "free")}:</b> ${formatMoney(snapshot.freeRemaining, currency, language)}`,
    `⚡️ <b>${t(language, "safeToSpend")}:</b> ${formatMoney(snapshot.safeToSpendPerDay, currency, language)}/${t(language, "day")}`,
    `${t(language, "status")}: ${escapeHtml(statusLabel(snapshot.status, language))}`
  ].join("\n");
}

export function formatWeeklyReport(dashboard, options = {}) {
  const language = normalizeLanguage(options.language);
  const snapshot = dashboard.snapshot;
  const currency = snapshot.baseCurrency ?? "THB";
  const top = (dashboard.topCategories ?? [])
    .slice(0, 3)
    .map((category, index) => `${index + 1}. ${escapeHtml(categoryName(category.category_slug))}: ${formatMoney(category.total, currency, language)}`)
    .join("\n");
  return [
    `📊 <b>${t(language, "weeklyReport")}</b>`,
    "",
    `${t(language, "week")}: <b>${formatMoney(snapshot.week, currency, language)}</b>`,
    `${t(language, "month")}: <b>${formatAmount(snapshot.month, language)} / ${formatMoney(snapshot.monthlyBudget, currency, language)}</b>`,
    `${t(language, "safeToSpend")}: <b>${formatMoney(snapshot.safeToSpendPerDay, currency, language)}</b>`,
    `${t(language, "monthForecast")}: <b>${formatMoney(snapshot.forecastMonthTotal ?? 0, currency, language)}</b>`,
    "",
    top ? `<b>${t(language, "topCategories")}:</b>\n${top}` : t(language, "topCategoriesEmpty")
  ].join("\n");
}

export function formatPlannedDraft(item, options = {}) {
  const language = normalizeLanguage(options.language);
  const labels = {
    ru: {
      title: "Плановая трата",
      repeat: "Повтор",
      category: "Категория",
      question: "Добавить в план?"
    },
    en: {
      title: "Planned expense",
      repeat: "Repeat",
      category: "Category",
      question: "Add it to the plan?"
    }
  };
  const text = labels[language];
  return [
    `🧾 <b>${text.title}</b>`,
    "",
    `<b>${escapeHtml(item.description)}</b>`,
    `${formatMoney(item.amount, item.currency, language)}`,
    `${text.repeat}: ${escapeHtml(formatRecurrence(item, language))}`,
    `${text.category}: ${escapeHtml(categoryName(item.category_slug))}`,
    "",
    text.question
  ].join("\n");
}

export function normalizeLanguage(value) {
  return value === "en" ? "en" : "ru";
}

function statusLabel(status, language) {
  const labels = {
    ru: {
      above_plan: "чуть быстрее плана",
      below_plan: "ниже плана",
      on_plan: "в плане"
    },
    en: {
      above_plan: "ahead of plan",
      below_plan: "below plan",
      on_plan: "on plan"
    }
  };
  return labels[language][status] ?? status;
}

const messages = {
  ru: {
    aboveBy: "выше на",
    belowBy: "ниже на",
    budget: "Бюджет",
    day: "день",
    draftReview: "Есть сомнительные строки, проверь перед сохранением.",
    draftTitle: "Я понял так:",
    forecast: "Прогноз",
    free: "Осталось",
    isCorrect: "Все верно?",
    month: "Месяц",
    monthForecast: "Прогноз месяца",
    noDate: "дата не указана",
    now: "Сейчас",
    plan: "План",
    planned: "Плановые",
    safeToSpend: "Можно в день до конца месяца",
    safeToday: "Можно еще сегодня",
    savedExpense: "Записал расход",
    spent: "Потрачено",
    status: "Статус",
    returnToBudget: "Вернуться в бюджет",
    forecastAboveBudget: "прогноз выше бюджета на",
    holdPace: "Чтобы вернуться в план, держи",
    today: "Сегодня",
    topCategories: "Топ категорий",
    topCategoriesEmpty: "Топ категорий пока пуст.",
    total: "Итого",
    week: "Неделя",
    weeklyReport: "Еженедельный отчет",
    withPlanned: "с учетом плановых трат до конца месяца"
  },
  en: {
    aboveBy: "above by",
    belowBy: "below by",
    budget: "Budget",
    day: "day",
    draftReview: "Some lines need review before saving.",
    draftTitle: "I understood this:",
    forecast: "Forecast",
    free: "Remaining",
    isCorrect: "Is everything correct?",
    month: "Month",
    monthForecast: "Month forecast",
    noDate: "date not set",
    now: "Now",
    plan: "Plan",
    planned: "Planned",
    safeToSpend: "Safe per day until month end",
    safeToday: "Safe left today",
    savedExpense: "Saved expense",
    spent: "Spent",
    status: "Status",
    returnToBudget: "Return to budget",
    forecastAboveBudget: "forecast is above budget by",
    holdPace: "To get back on plan, keep",
    today: "Today",
    topCategories: "Top categories",
    topCategoriesEmpty: "Top categories are empty for now.",
    total: "Total",
    week: "Week",
    weeklyReport: "Weekly report",
    withPlanned: "including planned expenses until the end of the month"
  }
};

function t(language, key) {
  return messages[language][key];
}

function formatRecurrence(item, language) {
  if (item.recurrence === "weekly") {
    const names = {
      ru: ["", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"],
      en: ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    };
    return language === "ru" ? `каждый ${names.ru[item.weekday] ?? names.ru[1]}` : `every ${names.en[item.weekday] ?? names.en[1]}`;
  }
  if (item.recurrence === "twice_monthly") {
    const days = Array.isArray(item.due_days) ? item.due_days.join(", ") : item.due_day;
    return language === "ru" ? `2 раза в месяц: ${days}` : `twice a month: ${days}`;
  }
  const day = item.due_day ?? item.due_days?.[0] ?? 1;
  return language === "ru" ? `каждый месяц, ${day} числа` : `monthly, day ${day}`;
}

function formatMoney(value, currency, language) {
  return `${formatAmount(value, language)} ${currency}`;
}

function formatAmount(value, language) {
  return new Intl.NumberFormat(language === "ru" ? "ru-RU" : "en-US", { maximumFractionDigits: 2 }).format(Number(value));
}

function formatSpentAt(value, language) {
  if (!value) return t(language, "noDate");
  return new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "en-US", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Bangkok"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
