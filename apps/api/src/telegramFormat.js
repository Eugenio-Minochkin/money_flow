import { categoryName } from "../../../packages/shared/src/categories.js";

export function formatDraft(expenses, options = {}) {
  const language = normalizeLanguage(options.language);
  const lines = expenses.map((expense, index) =>
    `${index + 1}. <b>${escapeHtml(categoryName(expense.category_slug))}</b>\n   ${escapeHtml(expense.description)} · <b>${formatAmount(expense.amount, language)} ${expense.currency}</b>`
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
    `<b>${t(language, "total")}:</b> ${formatAmount(total, language)} THB.${review}`,
    "",
    t(language, "isCorrect")
  ].join("\n");
}

export function formatSavedSummary(total, snapshot, options = {}) {
  const language = normalizeLanguage(options.language);
  const progress = snapshot.budgetProgressPercent == null ? "" : ` (${formatAmount(snapshot.budgetProgressPercent, language)}%)`;
  const planDeviation = Number(snapshot.planDeviation ?? 0);
  const planLine = planDeviation > 0
    ? `⚠️ <b>${t(language, "plan")}:</b> ${t(language, "aboveBy")} ${formatAmount(Math.abs(planDeviation), language)} THB`
    : `🟢 <b>${t(language, "plan")}:</b> ${t(language, "belowBy")} ${formatAmount(Math.abs(planDeviation), language)} THB`;

  return [
    `✅ <b>${t(language, "savedExpense")}</b>`,
    `<b>${formatAmount(total, language)} THB</b>`,
    "",
    `<b>${t(language, "now")}</b>`,
    `📌 <b>${t(language, "today")}:</b> ${formatAmount(snapshot.today, language)} / ${formatAmount(snapshot.dayPlanLimit ?? snapshot.dailyPlanLimit, language)} THB`,
    `📆 <b>${t(language, "week")}:</b> ${formatAmount(snapshot.week, language)} / ${formatAmount(snapshot.weekPlanLimit ?? snapshot.weeklyBudget, language)} THB`,
    "",
    `<b>${t(language, "month")}</b>`,
    `📅 <b>${t(language, "spent")}:</b> ${formatAmount(snapshot.month, language)} / ${formatAmount(snapshot.monthlyBudget, language)} THB${progress}`,
    `🟢 <b>${t(language, "free")}:</b> ${formatAmount(snapshot.freeRemaining, language)} THB`,
    `🧾 <b>${t(language, "planned")}:</b> ${formatAmount(snapshot.plannedRemaining, language)} THB`,
    `🔮 <b>${t(language, "forecast")}:</b> ${formatAmount(snapshot.forecastMonthTotal ?? 0, language)} THB`,
    planLine,
    "",
    `⚡️ <b>${t(language, "safeToSpend")}:</b> ${formatAmount(snapshot.safeToSpendPerDay, language)} THB/${t(language, "day")}`,
    t(language, "withPlanned")
  ].join("\n");
}

export function formatTotals(command, snapshot, options = {}) {
  const language = normalizeLanguage(options.language);
  if (command === "/today") {
    return [
      `📌 <b>${t(language, "today")}:</b> ${formatAmount(snapshot.today, language)} THB`,
      `⚡️ <b>${t(language, "safeToSpend")}:</b> ${formatAmount(snapshot.safeToSpendPerDay, language)} THB/${t(language, "day")}`
    ].join("\n");
  }
  if (command === "/week") return `📆 <b>${t(language, "week")}:</b> ${formatAmount(snapshot.week, language)} THB`;
  if (command === "/month") {
    const progress = snapshot.budgetProgressPercent == null ? "" : ` (${formatAmount(snapshot.budgetProgressPercent, language)}%)`;
    return [
      `📅 <b>${t(language, "month")}:</b> ${formatAmount(snapshot.month, language)} / ${formatAmount(snapshot.monthlyBudget, language)} THB${progress}`,
      `🔮 <b>${t(language, "forecast")}:</b> ${formatAmount(snapshot.forecastMonthTotal ?? 0, language)} THB`
    ].join("\n");
  }
  return [
    `💰 <b>${t(language, "budget")}:</b> ${formatAmount(snapshot.monthlyBudget, language)} THB`,
    `📅 <b>${t(language, "month")}:</b> ${formatAmount(snapshot.month, language)} THB`,
    `🧾 <b>${t(language, "planned")}:</b> ${formatAmount(snapshot.plannedRemaining, language)} THB`,
    `🟢 <b>${t(language, "free")}:</b> ${formatAmount(snapshot.freeRemaining, language)} THB`,
    `⚡️ <b>${t(language, "safeToSpend")}:</b> ${formatAmount(snapshot.safeToSpendPerDay, language)} THB/${t(language, "day")}`,
    `${t(language, "status")}: ${escapeHtml(statusLabel(snapshot.status, language))}`
  ].join("\n");
}

export function formatWeeklyReport(dashboard, options = {}) {
  const language = normalizeLanguage(options.language);
  const snapshot = dashboard.snapshot;
  const top = (dashboard.topCategories ?? [])
    .slice(0, 3)
    .map((category, index) => `${index + 1}. ${escapeHtml(categoryName(category.category_slug))}: ${formatAmount(category.total, language)} THB`)
    .join("\n");
  return [
    `📊 <b>${t(language, "weeklyReport")}</b>`,
    "",
    `${t(language, "week")}: <b>${formatAmount(snapshot.week, language)} THB</b>`,
    `${t(language, "month")}: <b>${formatAmount(snapshot.month, language)} / ${formatAmount(snapshot.monthlyBudget, language)} THB</b>`,
    `${t(language, "safeToSpend")}: <b>${formatAmount(snapshot.safeToSpendPerDay, language)} THB</b>`,
    `${t(language, "monthForecast")}: <b>${formatAmount(snapshot.forecastMonthTotal ?? 0, language)} THB</b>`,
    "",
    top ? `<b>${t(language, "topCategories")}:</b>\n${top}` : t(language, "topCategoriesEmpty")
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
    free: "Свободно",
    isCorrect: "Все верно?",
    month: "Месяц",
    monthForecast: "Прогноз месяца",
    now: "Сейчас",
    plan: "План",
    planned: "Плановые",
    safeToSpend: "Можно в день до конца месяца",
    savedExpense: "Записал расход",
    spent: "Потрачено",
    status: "Статус",
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
    free: "Free",
    isCorrect: "Is everything correct?",
    month: "Month",
    monthForecast: "Month forecast",
    now: "Now",
    plan: "Plan",
    planned: "Planned",
    safeToSpend: "Safe per day until month end",
    savedExpense: "Saved expense",
    spent: "Spent",
    status: "Status",
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

function formatAmount(value, language) {
  return new Intl.NumberFormat(language === "ru" ? "ru-RU" : "en-US", { maximumFractionDigits: 2 }).format(Number(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
