import { categoryName } from "../../../packages/shared/src/categories.js";

export function formatDraft(expenses, options = {}) {
  const language = normalizeLanguage(options.language);
  const currencies = [...new Set(expenses.map((expense) => expense.currency))];
  const singleCurrency = currencies.length <= 1;
  const totalCurrency = singleCurrency
    ? (currencies[0] ?? options.baseCurrency ?? "THB")
    : (options.baseCurrency ?? "THB");
  let lines = expenses.map((expense, index) =>
    `${index + 1}. <b>${escapeHtml(categoryName(expense.category_slug))}</b>\n   🗓 ${formatSpentAt(expense.spent_at, language)}\n   ${escapeHtml(expense.description)} · <b>${formatMoney(expense.amount, expense.currency, language)}</b>`
  );
  lines = lines.map((line, index) => line.replace("</b>", `</b>${formatBudgetImpactMarker(expenses[index]?.budget_impact, language)}`));
  const convertedPreview = isConvertedDraftPreview(options.preview, totalCurrency);
  const totalText = singleCurrency
    ? formatDraftAggregateMoney(expenses.reduce((sum, expense) => sum + safeMoneyNumber(expense.amount), 0), totalCurrency, language)
    : convertedPreview
      ? formatMoney(convertedPreview.total, totalCurrency, language)
      : formatDraftCurrencySubtotals(expenses, language);
  const unavailableTotalWarning = !singleCurrency && !convertedPreview
    ? `\n\n⚠️ ${formatDraftUnavailableTotalWarning(totalCurrency, language)}`
    : "";
  const review = expenses.some((expense) => expense.needs_review)
    ? `\n\n⚠️ ${t(language, "draftReview")}`
    : "";
  const treatment = expenses.length === 1
    ? `\n\n${formatDraftTreatmentExplanation(expenses[0]?.budget_impact, language)}`
    : "";
  return [
    `🧾 <b>${t(language, "draftTitle")}</b>`,
    "",
    lines.join("\n\n"),
    "",
    `<b>${t(language, "total")}:</b> ${totalText}.${unavailableTotalWarning}${review}${treatment}`,
    "",
    t(language, "isCorrect")
  ].join("\n");
}

function isConvertedDraftPreview(preview, baseCurrency) {
  if (!preview || typeof preview !== "object") return null;
  if (preview.kind !== "converted" || preview.baseCurrency !== baseCurrency) return null;
  if (typeof preview.total !== "number" || !Number.isFinite(preview.total)) return null;
  return preview;
}

function formatDraftCurrencySubtotals(expenses, language) {
  const subtotals = new Map();
  for (const expense of expenses) {
    const currency = expense.currency;
    subtotals.set(currency, (subtotals.get(currency) ?? 0) + safeMoneyNumber(expense.amount));
  }
  return [...subtotals].map(([currency, amount]) => formatDraftAggregateMoney(amount, currency, language)).join(" + ");
}

function formatDraftAggregateMoney(amount, currency, language) {
  if (!Number.isFinite(amount)) {
    return language === "en" ? `unavailable ${currency}` : `недоступно ${currency}`;
  }
  return formatMoney(amount, currency, language);
}

function formatDraftUnavailableTotalWarning(baseCurrency, language) {
  return language === "en"
    ? `A reliable total in ${baseCurrency} is unavailable. Amounts are shown by currency.`
    : `Надежная общая сумма в ${baseCurrency} недоступна. Суммы показаны по валютам.`;
}

function formatDraftTreatmentExplanation(impact, language) {
  const en = language === "en";
  const regular = impact !== "large_oneoff";
  const title = en ? "How should this expense affect the budget?" : "Как учесть расход?";
  const regularLabel = `${regular ? "◉" : "○"} ${en ? "Count today" : "Учесть сегодня"}`;
  const largeLabel = `${regular ? "○" : "◉"} ${en ? "Spread across remaining days" : "Распределить до конца месяца"}`;
  const detail = regular
    ? (en ? "This reduces today's limit." : "Этот расход уменьшает лимит на сегодня.")
    : (en ? "This stays in the month total without reducing today's limit in full." : "Этот расход остаётся в сумме месяца и не уменьшает сегодняшний лимит целиком.");
  return `<b>${title}</b>\n${regularLabel}\n${largeLabel}\n${detail}`;
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
  const dayPlanLimit = Number(snapshot.dayPlanLimit ?? 0);
  const dayRemaining = Number(snapshot.dayRemaining ?? 0);
  const dayOverrun = Number(snapshot.dayOverrun ?? 0);
  const plannedToday = Number(snapshot.plannedToday ?? snapshot.plannedTodayTotal ?? 0);
  const largeToday = Number(snapshot.largeToday ?? snapshot.largeTodayTotal ?? 0);
  const totalToday = todayTotal + plannedToday + largeToday;
  const forecastPlanDelta = Number(snapshot.forecastMonthTotal ?? 0) - Number(snapshot.monthlyBudget ?? 0);
  const planLine = forecastPlanDelta > 0
    ? `⚠️ <b>${t(language, "plan")}:</b> ${t(language, "aboveBy")} ${formatMoney(Math.abs(forecastPlanDelta), currency, language)}`
    : `🟢 <b>${t(language, "plan")}:</b> ${t(language, "belowBy")} ${formatMoney(Math.abs(forecastPlanDelta), currency, language)}`;
  const recovery = formatRecoveryAdvice(snapshot, language);
  const savedLines = formatSavedExpenseLines(options.expenses, total, currency, language);
  const todayLine = `${t(language, "regular")}: <b>${formatMoney(todayTotal, currency, language)} / ${formatMoney(dayPlanLimit, currency, language)}</b>`;
  const remainingLine = dayOverrun > 0
    ? `${t(language, "overrun")}: <b>${formatMoney(dayOverrun, currency, language)}</b>`
    : `${t(language, "remainingToday")}: <b>${formatMoney(dayRemaining, currency, language)}</b>`;

  const lines = [
    `✅ <b>${t(language, "savedExpense")}:</b>`,
    savedLines,
    "",
    `📌 <b>${t(language, "today")}</b>`,
    todayLine,
    remainingLine,
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
  const itemLines = lines.map((line, index) => `${index + 1}. ${line}`).join("\n");
  return `${itemLines}\n<b>${t(language, "total")}:</b> ${formatMoney(total, currency, language)}`;
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

export function formatBudgetTopupDraft(item, options = {}) {
  const language = normalizeLanguage(options.language);
  const monthName = formatMonthName(item.month_key ?? monthKeyFromDate(item.occurred_at), language);
  const amount = formatMoney(item.amount, item.currency, language);
  if (options.large === true) {
    return language === "en"
      ? `\u26a0\ufe0f <b>Very large top-up:</b>\n+${amount}\n\nPlease check the amount. Add it to your ${monthName} budget?`
      : `\u26a0\ufe0f <b>Очень большое пополнение:</b>\n+${amount}\n\nПроверь сумму. Добавить к бюджету на ${monthName}?`;
  }
  return language === "en"
    ? `\u2795 <b>Budget top-up:</b>\n+${amount}\n\nAdd it to your ${monthName} budget?`
    : `\u2795 <b>Пополнение бюджета:</b>\n+${amount}\n\nДобавить к бюджету на ${monthName}?`;
}

export function formatBudgetTopupSuccess(topup, snapshot, languageValue = "ru") {
  const language = normalizeLanguage(languageValue);
  const currency = snapshot?.baseCurrency ?? topup?.base_currency ?? "THB";
  const monthBudget = Number(snapshot?.monthlyBudget ?? 0);
  const remaining = Number(snapshot?.freeRemaining ?? snapshot?.monthRemaining ?? 0);
  const original = formatMoney(topup?.amount_original ?? topup?.amount_base ?? 0, topup?.currency_original ?? currency, language);
  const convertedLine = topup?.currency_original && topup.currency_original !== currency
    ? (language === "en"
        ? `\n\nIn your budget currency, that is +${formatMoney(topup.amount_base, currency, language)}.`
        : `\n\nВ бюджете это учтено как +${formatMoney(topup.amount_base, currency, language)}.`)
    : "";
  return language === "en"
    ? `\u2705 <b>Budget updated:</b>\n+${original} · Budget top-up${convertedLine}\n\n\ud83d\udccc <b>Today</b>\nMonthly budget: <b>${formatMoney(monthBudget, currency, language)}</b>\nRemaining: <b>${formatMoney(remaining, currency, language)}</b>\n\n\u21a9\ufe0f You can undo this top-up for 10 minutes.`
    : `\u2705 <b>Бюджет обновлён:</b>\n+${original} · Пополнение бюджета${convertedLine}\n\n\ud83d\udccc <b>Сегодня</b>\nБюджет месяца: <b>${formatMoney(monthBudget, currency, language)}</b>\nОсталось: <b>${formatMoney(remaining, currency, language)}</b>\n\n\u21a9\ufe0f Можно отменить пополнение в течение 10 минут.`;
}

export function formatBudgetTopupUndoSuccess(topup, snapshot, languageValue = "ru") {
  const language = normalizeLanguage(languageValue);
  const currency = snapshot?.baseCurrency ?? topup?.base_currency ?? "THB";
  const amountLine = topup
    ? `\n-${formatMoney(topup.amount_original ?? topup.amount_base ?? 0, topup.currency_original ?? currency, language)}`
    : "";
  return language === "en"
    ? `\u21a9\ufe0f <b>Top-up undone:</b>${amountLine}\n\nMonthly budget: <b>${formatMoney(snapshot?.monthlyBudget ?? 0, currency, language)}</b>\nRemaining: <b>${formatMoney(snapshot?.freeRemaining ?? 0, currency, language)}</b>`
    : `\u21a9\ufe0f <b>Пополнение отменено:</b>${amountLine}\n\nБюджет месяца: <b>${formatMoney(snapshot?.monthlyBudget ?? 0, currency, language)}</b>\nОсталось: <b>${formatMoney(snapshot?.freeRemaining ?? 0, currency, language)}</b>`;
}

function formatMonthName(monthKey, language) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(monthKey ?? ""));
  if (!match) return language === "en" ? "this month" : "этого месяца";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "ru-RU", {
    month: "long",
    timeZone: "UTC"
  }).format(date);
}

function monthKeyFromDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
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
