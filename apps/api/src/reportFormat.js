const ZERO_DECIMAL_DISPLAY_CURRENCIES = new Set(["THB", "RUB", "IDR", "BYN"]);

export function formatWeeklyReport(report, options = {}) {
  const language = normalizeLanguage(options.language);
  const labels = language === "en" ? enLabels : ruLabels;
  const periodLabel = formatPeriodLabel(report.period, language);
  const metrics = report.metrics ?? {};
  const partition = displayPartition(metrics, report.currency);
  const lines = [
    `${labels.weeklyTitle}`,
    periodLabel,
    "",
    ...lineWithSecondary(`${labels.spent}: ${formatReportMoney(metrics.totalSpent, report.currency, language)}`, secondaryDisplayLine(metrics.display, "totalSpent", report.currency, language)),
    `${labels.average}: ${formatReportMoney(metrics.averagePerDay ?? 0, report.currency, language)}/${labels.day}`,
    "",
    `${labels.inside}:`,
    `${labels.plannedPaid} — ${formatReportMoney(partition.plannedPaidTotal, partition.currency, language)}`,
    `${labels.regular} — ${formatReportMoney(partition.regularTotal, partition.currency, language)}`
  ];
  pushOptional(lines, formatBudgetTopupsBlock(report.budgetTopups, metrics.budgetTopupsTotal, report.currency, language, true));
  pushOptional(lines, formatPlannedPaymentsBlock(report.plannedPayments, report.currency, language));
  pushOptional(lines, formatLargeExpensesBlock(report.largeExpenses, metrics.largeTotal, report.currency, language));
  pushOptional(lines, formatTopCategoriesBlock(report.topCategories, report.currency, language, 3));
  pushOptional(lines, formatOutsideBudgetLine(metrics, report.currency, language));
  pushOptional(lines, formatInsight(report.insight, language));
  return compactMessage(lines);
}

export function formatMonthlyReport(report, options = {}) {
  const language = normalizeLanguage(options.language);
  const labels = language === "en" ? enLabels : ruLabels;
  const metrics = report.metrics ?? {};
  const partition = displayPartition(metrics, report.currency);
  const lines = [
    `${labels.monthlyTitle(monthNameFromPeriod(report.period?.periodKey, language))}`,
    "",
    ...lineWithSecondary(`${labels.spent}: ${formatReportMoney(metrics.totalSpent, report.currency, language)}`, secondaryDisplayLine(metrics.display, "totalSpent", report.currency, language)),
    "",
    `${labels.monthlyBudget}:`,
    ...monthlyBudgetLines(report.budget, report.currency, language),
    "",
    `${labels.monthlyPace}:`,
    `${labels.average}: ${formatReportMoney(metrics.averagePerDay ?? 0, report.currency, language)}/${labels.day}`,
    "",
    `${labels.madeUp}:`,
    `${labels.plannedPaid} — ${formatReportMoney(partition.plannedPaidTotal, partition.currency, language)}`,
    `${labels.regular} — ${formatReportMoney(partition.regularTotal, partition.currency, language)}`
  ];
  pushOptional(lines, formatBudgetTopupsBlock(report.budgetTopups, metrics.budgetTopupsTotal, report.currency, language, false));
  pushOptional(lines, formatPlannedPaymentsBlock(report.plannedPayments, report.currency, language));
  pushOptional(lines, formatLargeExpensesBlock(report.largeExpenses, metrics.largeTotal, report.currency, language));
  pushOptional(lines, formatTopCategoriesBlock(report.topCategories, report.currency, language, 5));
  pushOptional(lines, formatOutsideBudgetLine(metrics, report.currency, language));
  pushOptional(lines, formatInsight(report.insight, language));
  return compactMessage(lines);
}

export function formatReportMoney(value, currency = "THB", language = "ru") {
  const normalized = String(currency || "THB").toUpperCase();
  const decimals = ZERO_DECIMAL_DISPLAY_CURRENCIES.has(normalized) ? 0 : 2;
  const amount = Number(value ?? 0);
  const formatted = new Intl.NumberFormat(language === "en" ? "en-US" : "ru-RU", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(amount).replace(/[\u00a0\u202f]/g, " ");
  return `${formatted} ${normalized}`;
}

function displayPartition(metrics = {}, fallbackCurrency = "THB") {
  const displayCurrency = metrics.display?.currency;
  if (displayCurrency && String(displayCurrency).toUpperCase() !== String(fallbackCurrency).toUpperCase()) {
    return {
      currency: fallbackCurrency,
      plannedPaidTotal: metrics.plannedPaidTotal ?? 0,
      regularTotal: metrics.regularTotal ?? 0
    };
  }
  return {
    currency: displayCurrency ?? fallbackCurrency,
    plannedPaidTotal: metrics.display?.plannedPaidTotal ?? metrics.plannedPaidTotal ?? 0,
    regularTotal: metrics.display?.regularTotal ?? metrics.regularTotal ?? 0
  };
}

function lineWithSecondary(primaryLine, secondaryLine) {
  return secondaryLine ? [primaryLine, secondaryLine] : [primaryLine];
}

function secondaryDisplayLine(display = {}, field, primaryCurrency, language, absolute = false) {
  const currency = display?.currency;
  if (!currency || String(currency).toUpperCase() === String(primaryCurrency).toUpperCase()) return null;
  const value = display[field];
  if (value == null || !Number.isFinite(Number(value))) return null;
  return `≈ ${formatReportMoney(absolute ? Math.abs(Number(value)) : value, currency, language)}`;
}

function monthlyBudgetLines(budget = {}, currency, language) {
  const hasTopups = Number(budget.topupsTotal ?? 0) > 0;
  const remaining = Number(budget.remaining ?? 0);
  const finalEquivalent = secondaryDisplayLine(budget.display, "amount", currency, language);
  const remainingEquivalent = secondaryDisplayLine(budget.display, "remaining", currency, language, true);
  const finalLine = language === "en"
    ? (hasTopups ? `Final budget — ${formatReportMoney(budget.amount, currency, language)}` : `Budget — ${formatReportMoney(budget.amount, currency, language)}`)
    : (hasTopups ? `Итоговый бюджет — ${formatReportMoney(budget.amount, currency, language)}` : `Бюджет — ${formatReportMoney(budget.amount, currency, language)}`);
  const remainingLine = remaining >= 0
    ? (language === "en" ? `Remaining: ${formatReportMoney(remaining, currency, language)}` : `Осталось: ${formatReportMoney(remaining, currency, language)}`)
    : (language === "en" ? `Overspent: ${formatReportMoney(Math.abs(remaining), currency, language)}` : `Перерасход: ${formatReportMoney(Math.abs(remaining), currency, language)}`);
  if (language === "en") {
    return [
      ...(hasTopups
        ? [
            `Starting budget — ${formatReportMoney(budget.baseBudget, currency, language)}`,
            `Top-ups — +${formatReportMoney(budget.topupsTotal, currency, language)}`,
            ...lineWithSecondary(finalLine, finalEquivalent)
          ]
        : lineWithSecondary(finalLine, finalEquivalent)),
      ...lineWithSecondary(remainingLine, remainingEquivalent)
    ];
  }
  return [
    ...(hasTopups
      ? [
          `Стартовый бюджет — ${formatReportMoney(budget.baseBudget, currency, language)}`,
          `Пополнения — +${formatReportMoney(budget.topupsTotal, currency, language)}`,
          ...lineWithSecondary(finalLine, finalEquivalent)
        ]
      : lineWithSecondary(finalLine, finalEquivalent)),
    ...lineWithSecondary(remainingLine, remainingEquivalent)
  ];
}

function formatBudgetTopupsBlock(topups = [], total, currency, language, weekly) {
  if (!Array.isArray(topups) || topups.length === 0) return null;
  const heading = language === "en"
    ? (weekly ? "💰 Budget top-ups this week:" : "💰 Budget top-ups:")
    : (weekly ? "💰 Пополнения бюджета на этой неделе:" : "💰 Пополнения бюджета:");
  const totalLabel = language === "en" ? (weekly ? "Total" : "Total topped up") : (weekly ? "Всего" : "Всего пополнено");
  return [
    heading,
    ...topups.map((topup) => `• ${formatDate(topup.date, language)} — +${formatReportMoney(topup.amount, currency, language)}`),
    `${totalLabel}: +${formatReportMoney(total ?? sum(topups, "amount"), currency, language)}`
  ].join("\n");
}

function formatPlannedPaymentsBlock(items = [], currency, language) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const paid = items.filter((item) => item.paid);
  const unpaid = items.filter((item) => !item.paid);
  const paidTotal = sum(paid, "amount");
  const unpaidTotal = sum(unpaid, "amount");
  const heading = language === "en"
    ? `📌 Planned payments (${paid.length} of ${items.length} paid):`
    : `📌 Плановые оплаты (${paid.length} из ${items.length} оплачено):`;
  const lines = [
    heading,
    language === "en"
      ? `Paid: ${formatReportMoney(paidTotal, currency, language)}`
      : `Оплачено: ${formatReportMoney(paidTotal, currency, language)}`
  ];
  if (unpaid.length > 0) {
    lines.push(language === "en"
      ? `Not marked: ${formatReportMoney(unpaidTotal, currency, language)}`
      : `Не отмечено: ${formatReportMoney(unpaidTotal, currency, language)}`);
  }
  lines.push("");
  lines.push(...items.map((item) => {
    const status = item.paid
      ? (language === "en" ? "paid" : "оплачено")
      : `${language === "en" ? "not marked" : "не отмечено"}, ${formatDate(item.dueDate, language)}`;
    return `• ${item.name} — ${formatReportMoney(item.amount, currency, language)}, ${status}`;
  }));
  return lines.join("\n");
}

function formatLargeExpensesBlock(items = [], total, currency, language) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const heading = language === "en" ? "⚡ Large expenses inside the total:" : "⚡ Крупные траты внутри суммы:";
  const totalLabel = language === "en" ? "Large total" : "Всего крупными";
  return [
    heading,
    ...items.map((item) => `• ${formatDate(item.date, language)} — ${item.name} — ${formatReportMoney(item.amount, currency, language)}`),
    `${totalLabel}: ${formatReportMoney(total ?? sum(items, "amount"), currency, language)}`
  ].join("\n");
}

function formatTopCategoriesBlock(items = [], currency, language, limit) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const heading = language === "en" ? "🏷️ Top categories:" : "🏷️ Главные категории:";
  return [
    heading,
    ...items.slice(0, limit).map((item, index) => `${index + 1}. ${item.name} — ${formatReportMoney(item.amount, currency, language)}`)
  ].join("\n");
}

function formatOutsideBudgetLine(metrics, currency, language) {
  if (!metrics?.showOutsideBudget || Number(metrics.outOfBudgetTotal ?? 0) <= 0) return null;
  return language === "en"
    ? `🚧 Outside budget: ${formatReportMoney(metrics.outOfBudgetTotal, currency, language)}`
    : `🚧 Вне бюджета: ${formatReportMoney(metrics.outOfBudgetTotal, currency, language)}`;
}

function formatInsight(insight, language) {
  if (!insight) return null;
  return language === "en" ? `💬 Insight:\n${insight}` : `💬 Вывод:\n${insight}`;
}

function formatPeriodLabel(period = {}, language) {
  if (!period.localStartDate || !period.localEndDate) return "";
  const start = dateParts(period.localStartDate);
  const end = dateParts(period.localEndDate);
  if (language === "en") {
    const month = monthName(start.month, language);
    const endMonth = start.month === end.month ? "" : `${monthName(end.month, language)} `;
    return `${month} ${start.day}–${endMonth}${end.day}`;
  }
  const month = monthName(end.month, language);
  return `${start.day}–${end.day} ${month}`;
}

function monthNameFromPeriod(periodKey, language) {
  const month = Number(String(periodKey ?? "").slice(5, 7));
  return language === "ru" ? nominativeMonthName(month || 1) : monthName(month || 1, language);
}

function formatDate(value, language) {
  const parts = dateParts(value);
  return language === "en"
    ? `${monthName(parts.month, language)} ${parts.day}`
    : `${parts.day} ${monthName(parts.month, language)}`;
}

function monthName(month, language) {
  const names = language === "en"
    ? ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
    : ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const value = names[Math.max(1, Math.min(12, Number(month))) - 1];
  if (language === "ru" && value === "июня") return "июня";
  return value;
}

function nominativeMonthName(month) {
  const names = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
  return names[Math.max(1, Math.min(12, Number(month))) - 1];
}

function dateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return { year: 1970, month: 1, day: 1 };
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function pushOptional(lines, block) {
  if (!block) return;
  lines.push("", block);
}

function compactMessage(lines) {
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function sum(items, field) {
  return items.reduce((total, item) => total + Number(item?.[field] ?? 0), 0);
}

function normalizeLanguage(value) {
  return value === "en" ? "en" : "ru";
}

const ruLabels = {
  weeklyTitle: "📊 Итоги недели",
  monthlyTitle: (month) => `🧾 ${capitalize(month)} закрыт`,
  spent: "💸 Потрачено",
  average: "В среднем",
  day: "день",
  inside: "🧩 Внутри этой суммы",
  madeUp: "🧩 Из чего сложился месяц",
  plannedPaid: "Плановые оплаты",
  regular: "Остальные расходы",
  monthlyBudget: "💰 Бюджет месяца",
  monthlyPace: "📊 Темп месяца"
};

const enLabels = {
  weeklyTitle: "📊 Weekly summary",
  monthlyTitle: (month) => `🧾 ${month} is closed`,
  spent: "💸 Spent",
  average: "Average",
  day: "day",
  inside: "🧩 Inside this amount",
  madeUp: "🧩 What made up the month",
  plannedPaid: "Planned payments",
  regular: "Other expenses",
  monthlyBudget: "💰 Monthly budget",
  monthlyPace: "📊 Monthly pace"
};

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
