import { categoryName } from "../../../packages/shared/src/categories.js";

export function formatDraft(expenses, options = {}) {
  const language = normalizeLanguage(options.language);
  const totalCurrency = expenses.every((expense) => expense.currency === expenses[0]?.currency)
    ? expenses[0]?.currency
    : (options.baseCurrency ?? "THB");
  let lines = expenses.map((expense, index) =>
    `${index + 1}. <b>${escapeHtml(categoryName(expense.category_slug))}</b>\n   🗓 ${formatSpentAt(expense.spent_at, language)}\n   ${escapeHtml(expense.description)} · <b>${formatMoney(expense.amount, expense.currency, language)}</b>`
  );
  lines = lines.map((line, index) => line.replace("</b>", `</b>${formatBudgetImpactMarker(expenses[index]?.budget_impact, language)}`));
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

function formatBudgetImpactMarker(value, language) {
  if (value === "planned") return language === "en" ? " · 🧾 Planned" : " · 🧾 Плановая";
  if (value === "large_oneoff") return language === "en" ? " · 📦 Large" : " · 📦 Крупная";
  return "";
}

export function formatSavedSummary(total, snapshot, options = {}) {
  const language = normalizeLanguage(options.language);
  const currency = snapshot.baseCurrency ?? "THB";
  const progress = snapshot.budgetProgressPercent == null ? "" : ` (${formatAmount(snapshot.budgetProgressPercent, language)}%)`;
  const todayTotal = Number(snapshot.today ?? 0);
  const dayPlanLimit = Number(snapshot.dayPlanLimit ?? snapshot.dailyPlanLimit ?? 0);
  const dayRemaining = Number(snapshot.dayRemaining ?? Math.max(dayPlanLimit - todayTotal, 0));
  const dayOverrun = Number(snapshot.dayOverrun ?? Math.max(todayTotal - dayPlanLimit, 0));
  const plannedToday = Number(snapshot.plannedToday ?? snapshot.plannedTodayTotal ?? 0);
  const largeToday = Number(snapshot.largeToday ?? snapshot.largeTodayTotal ?? 0);
  const totalToday = todayTotal + plannedToday + largeToday;
  const forecastPlanDelta = Number(snapshot.forecastMonthTotal ?? 0) - Number(snapshot.monthlyBudget ?? 0);
  const planLine = forecastPlanDelta > 0
    ? `⚠️ <b>${t(language, "plan")}:</b> ${t(language, "aboveBy")} ${formatMoney(Math.abs(forecastPlanDelta), currency, language)}`
    : `🟢 <b>${t(language, "plan")}:</b> ${t(language, "belowBy")} ${formatMoney(Math.abs(forecastPlanDelta), currency, language)}`;
  const recovery = formatRecoveryAdvice(snapshot, language);
  const savedLines = formatSavedExpenseLines(options.expenses, total, currency, language);
  const todayBudgetLine = dayPlanLimit > 0
    ? `${t(language, "regular")}: <b>${formatMoney(todayTotal, currency, language)} / ${formatMoney(dayPlanLimit, currency, language)}</b>`
    : `${t(language, "regular")}: <b>${formatMoney(todayTotal, currency, language)}</b>`;
  const todayRemainingLine = dayOverrun > 0
    ? `${t(language, "overrun")}: <b>${formatMoney(dayOverrun, currency, language)}</b>`
    : `${t(language, "remainingToday")}: <b>${formatMoney(dayRemaining, currency, language)}</b>`;

  const lines = [
    `✅ <b>${t(language, "savedExpense")}:</b>`,
    savedLines,
    "",
    `📌 <b>${t(language, "today")}</b>`,
    todayBudgetLine,
    todayRemainingLine,
    "",
    `🧾 ${t(language, "plannedToday")}: <b>${formatMoney(plannedToday, currency, language)}</b>`,
    `📦 ${t(language, "largeToday")}: <b>${formatMoney(largeToday, currency, language)}</b>`,
    `${t(language, "totalToday")}: <b>${formatMoney(totalToday, currency, language)}</b>`,
    "",
    `<b>${t(language, "month")}</b>`,
    `📅 <b>${t(language, "spent")}:</b> ${formatMoney(snapshot.month, currency, language)} / ${formatMoney(snapshot.monthlyBudget, currency, language)}${progress}`,
    `🟢 <b>${t(language, "free")}:</b> ${formatMoney(snapshot.freeRemaining, currency, language)}`,
    `🧾 <b>${t(language, "planned")}:</b> ${formatMoney(snapshot.plannedRemaining, currency, language)}`,
    `🔮 <b>${t(language, "forecast")}:</b> ${formatMoney(snapshot.forecastMonthTotal ?? 0, currency, language)}`,
    planLine
  ];
  if (recovery) lines.push("", recovery);
  return lines.join("\n");
}

function formatSavedExpenseLines(expenses, total, currency, language) {
  if (!Array.isArray(expenses) || expenses.length === 0) {
    return formatMoney(total, currency, language);
  }
  const lines = expenses.map((expense) => {
    const amount = expense.amount_original ?? expense.amount ?? expense.amount_base ?? 0;
    const expenseCurrency = expense.currency_original ?? expense.currency ?? expense.base_currency ?? currency;
    return [
      escapeHtml(categoryName(expense.category_slug)),
      escapeHtml(expense.description ?? ""),
      formatMoney(amount, expenseCurrency, language)
    ].filter(Boolean).join(" · ");
  });
  if (lines.length === 1) return lines[0];
  return lines.map((line, index) => `${index + 1}. ${line}`).join("\n");
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
      `📅 <b>${t(language, "month")}:</b> ${formatMoney(snapshot.month, currency, language)} / ${formatMoney(snapshot.monthlyBudget, currency, language)}${progress}`,
      `🔮 <b>${t(language, "forecast")}:</b> ${formatMoney(snapshot.forecastMonthTotal ?? 0, currency, language)}`
    ].join("\n");
  }
  const lines = [
    `💰 <b>${t(language, "budget")}:</b> ${formatMoney(snapshot.monthlyBudget, currency, language)}`,
    `📅 <b>${t(language, "month")}:</b> ${formatMoney(snapshot.month, currency, language)}`,
    `🧾 <b>${t(language, "planned")}:</b> ${formatMoney(snapshot.plannedRemaining, currency, language)}`,
    `🟢 <b>${t(language, "free")}:</b> ${formatMoney(snapshot.freeRemaining, currency, language)}`,
    `⚡️ <b>${t(language, "safeToSpend")}:</b> ${formatMoney(snapshot.safeToSpendPerDay, currency, language)}/${t(language, "day")}`,
    `${t(language, "status")}: ${escapeHtml(statusLabel(snapshot.status, language))}`
  ];
  if (snapshot.reserve) {
    const reserveStatus = snapshot.reserve.status === "saved"
      ? (language === "en" ? "Reserve saved" : "Резерв сохранён")
      : snapshot.reserve.status === "partially_used"
        ? (language === "en" ? "Reserve at risk" : "Резерв под угрозой")
        : (language === "en" ? "Reserve used up" : "Резерв съеден");
    lines.splice(4, 0,
      `🛡 <b>${reserveStatus}:</b> ${formatMoney(snapshot.reserve.eatenAmount, currency, language)}`,
      `💵 <b>${language === "en" ? "Available for regular spending" : "Доступно на обычные расходы"}:</b> ${formatMoney(snapshot.availableRegular, currency, language)}`
    );
  }
  return lines.join("\n");
}

export function formatReserveClosedEvent(event, options = {}) {
  const language = normalizeLanguage(options.language);
  const currency = event.currency ?? "THB";
  const reserve = formatMoney(event.reserve_amount, currency, language);
  const saved = formatMoney(event.saved_amount, currency, language);
  const over = formatMoney(event.over_budget_amount, currency, language);
  const title = event.title ? ` ${language === "en" ? "for" : "на"} ${escapeHtml(event.title)}` : "";
  if (event.status === "saved") {
    return language === "en"
      ? `Great job, the month is closed 🔥\nYou stayed within budget and kept your ${reserve} reserve${title}.`
      : `Красава, месяц закрыт 🔥\nТы уложился в бюджет и сохранил резерв ${reserve}${title}.`;
  }
  if (event.status === "partially_used") {
    return language === "en"
      ? `Month closed.\nYou kept ${saved} out of your ${reserve} reserve.`
      : `Месяц закрыт.\nЧасть резерва удалось сохранить: ${saved} из ${reserve}.`;
  }
  if (event.status === "used_up_and_over_budget") {
    return language === "en"
      ? `This month, the reserve couldn’t be kept.\nThe ${reserve} reserve was used up, and you also went over budget by ${over}.`
      : `В этом месяце резерв сохранить не получилось.\nРезерв ${reserve} съеден, плюс есть перерасход бюджета на ${over}.`;
  }
  return language === "en"
    ? `This month, the reserve couldn’t be kept.\n${reserve} was used for regular spending.`
    : `В этом месяце резерв сохранить не получилось.\n${reserve} ушли на обычные расходы.`;
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
    `${t(language, "month")}: <b>${formatMoney(snapshot.month, currency, language)} / ${formatMoney(snapshot.monthlyBudget, currency, language)}</b>`,
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
    largeToday: "Крупные сегодня",
    isCorrect: "Все верно?",
    month: "Месяц",
    monthForecast: "Прогноз месяца",
    noDate: "дата не указана",
    now: "Сейчас",
    plan: "План",
    planned: "Плановые",
    plannedToday: "Плановые сегодня",
    overrun: "Перерасход",
    regular: "Обычные",
    remainingToday: "Осталось",
    safeToSpend: "Можно в день до конца месяца",
    safeToday: "Можно еще сегодня",
    savedExpense: "Записал",
    spent: "Потрачено",
    status: "Статус",
    returnToBudget: "Вернуться в бюджет",
    forecastAboveBudget: "прогноз выше бюджета на",
    holdPace: "Чтобы вернуться в план, держи",
    today: "Сегодня",
    topCategories: "Топ категорий",
    topCategoriesEmpty: "Топ категорий пока пуст.",
    total: "Итого",
    totalToday: "Всего за день",
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
    largeToday: "Large today",
    isCorrect: "Is everything correct?",
    month: "Month",
    monthForecast: "Month forecast",
    noDate: "date not set",
    now: "Now",
    plan: "Plan",
    planned: "Planned",
    plannedToday: "Planned today",
    overrun: "Overrun",
    regular: "Regular",
    remainingToday: "Remaining",
    safeToSpend: "Safe per day until month end",
    safeToday: "Safe left today",
    savedExpense: "Saved",
    spent: "Spent",
    status: "Status",
    returnToBudget: "Return to budget",
    forecastAboveBudget: "forecast is above budget by",
    holdPace: "To get back on plan, keep",
    today: "Today",
    topCategories: "Top categories",
    topCategoriesEmpty: "Top categories are empty for now.",
    total: "Total",
    totalToday: "Total today",
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

const ZERO_DECIMAL_DISPLAY_CURRENCIES = ["THB", "RUB", "IDR", "BYN"];
const TWO_DECIMAL_DISPLAY_CURRENCIES = ["USD", "EUR", "GEL"];

function formatMoney(value, currency, language) {
  const normalizedCurrency = String(currency || "THB").toUpperCase();
  return `${formatMoneyAmount(value, normalizedCurrency, language)} ${normalizedCurrency}`;
}

function formatMoneyAmount(value, currency, language) {
  const decimals = displayDecimalsForCurrency(currency);
  const numeric = safeMoneyNumber(value);
  const displayValue = decimals === 0 ? Math.round(numeric) : numeric;
  return new Intl.NumberFormat(language === "ru" ? "ru-RU" : "en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(displayValue);
}

function formatAmount(value, language) {
  return new Intl.NumberFormat(language === "ru" ? "ru-RU" : "en-US", { maximumFractionDigits: 2 }).format(safeMoneyNumber(value));
}

function displayDecimalsForCurrency(currency) {
  if (ZERO_DECIMAL_DISPLAY_CURRENCIES.includes(currency)) return 0;
  if (TWO_DECIMAL_DISPLAY_CURRENCIES.includes(currency)) return 2;
  return 2;
}

function safeMoneyNumber(value) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
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
