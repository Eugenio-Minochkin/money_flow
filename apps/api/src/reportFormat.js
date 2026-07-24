const ZERO_DECIMAL_DISPLAY_CURRENCIES = new Set(["THB", "RUB", "IDR", "BYN"]);

export function formatWeeklyReport(report, options = {}) {
  const language = normalizeLanguage(options.language);
  const labels = language === "en" ? enLabels : ruLabels;
  const periodLabel = formatPeriodLabel(report.period, language);
  const metrics = report.metrics ?? {};
  const currency = report.currency ?? "THB";
  const lines = [
    labels.weeklyTitle,
    periodLabel,
    "",
    ...lineWithSecondary(
      `${labels.spent}: ${boldMoney(metrics.totalSpent, currency, language)}`,
      secondaryDisplayLine(metrics.display, "totalSpent", currency, language)
    )
  ];

  const comparison = report.comparison ?? { available: false };
  if (comparison.available) {
    lines.push(formatComparisonLine(comparison, language));
  }
  if (Number(metrics.totalSpent ?? 0) > 0) {
    lines.push(formatAverageLine(metrics.averagePerDay, currency, language));
  }
  if (Number(metrics.budgetTopupsTotal ?? 0) > 0) {
    lines.push(labels.topupLine(formatReportMoney(metrics.budgetTopupsTotal, currency, language)));
  }
  if (metrics.showOutsideBudget && Number(metrics.outOfBudgetTotal ?? 0) > 0) {
    lines.push(labels.outsideLine(formatReportMoney(metrics.outOfBudgetTotal, currency, language)));
  }

  pushOptional(lines, formatWeeklyTopCategories(report.topCategories, report.topTwoCategoryShare, currency, language));
  pushOptional(lines, formatLargestExpenses(report.largestExpenses, currency, language));
  pushOptional(lines, formatWhatChanged(report.changes, currency, language));
  pushOptional(lines, formatNeedsAttention(report.needsAttention, currency, language));
  if (report.takeaway) {
    pushOptional(lines, `${labels.takeawayHeading}\n${escapeHtml(report.takeaway)}`);
  }
  if (report.firstWeek) {
    pushOptional(lines, labels.firstWeekLine);
  }
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
    ...lineWithSecondary(`${labels.spent}: ${boldMoney(metrics.totalSpent, report.currency, language)}`, secondaryDisplayLine(metrics.display, "totalSpent", report.currency, language)),
    "",
    `${labels.monthlyBudget}:`,
    ...monthlyBudgetLines(report.budget, report.currency, language),
    "",
    `${labels.monthlyPace}:`,
    ...paceLines(metrics, report.currency, language),
    "",
    `${labels.madeUp}:`,
    `${labels.plannedPaid} — ${boldMoney(partition.plannedPaidTotal, partition.currency, language)}`,
    `${labels.regular} — ${boldMoney(partition.regularTotal, partition.currency, language)}`
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
  const reportDisplay = metrics.reportDisplay;
  if (reportDisplay?.currency && String(reportDisplay.currency).toUpperCase() === String(fallbackCurrency).toUpperCase()) {
    return {
      currency: reportDisplay.currency,
      plannedPaidTotal: reportDisplay.plannedPaidTotal ?? metrics.plannedPaidTotal ?? 0,
      regularTotal: reportDisplay.regularTotal ?? metrics.regularTotal ?? 0
    };
  }
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

function paceLines(metrics = {}, currency, language) {
  const labels = language === "en" ? enLabels : ruLabels;
  const average = metrics.averagePerDay ?? 0;
  const regularAverage = metrics.regularAveragePerDay ?? average;
  if (Number(metrics.plannedPaidTotal ?? 0) > 0) {
    return [
      `${labels.everydaySpending}: ${bold(`${formatReportMoney(regularAverage, currency, language)}/${labels.day}`)}`,
      `${labels.includingPlanned}: ${formatReportMoney(average, currency, language)}/${labels.day}`
    ];
  }
  return [`${labels.average}: ${bold(`${formatReportMoney(regularAverage, currency, language)}/${labels.day}`)}`];
}

function lineWithSecondary(primaryLine, secondaryLine) {
  return secondaryLine ? [primaryLine, secondaryLine] : [primaryLine];
}

function boldMoney(value, currency, language) {
  return bold(formatReportMoney(value, currency, language));
}

function bold(value) {
  return `<b>${value}</b>`;
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
    ? (hasTopups ? `Final budget — ${boldMoney(budget.amount, currency, language)}` : `Budget — ${boldMoney(budget.amount, currency, language)}`)
    : (hasTopups ? `Итоговый бюджет — ${boldMoney(budget.amount, currency, language)}` : `Бюджет — ${boldMoney(budget.amount, currency, language)}`);
  const remainingLine = remaining >= 0
    ? (language === "en" ? `Remaining: ${boldMoney(remaining, currency, language)}` : `Осталось: ${boldMoney(remaining, currency, language)}`)
    : (language === "en" ? `Overspent: ${boldMoney(Math.abs(remaining), currency, language)}` : `Перерасход: ${boldMoney(Math.abs(remaining), currency, language)}`);
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
    return `• ${escapeHtml(item.name)} — ${formatReportMoney(item.amount, currency, language)}, ${status}`;
  }));
  return lines.join("\n");
}

function formatLargeExpensesBlock(items = [], total, currency, language) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const heading = language === "en" ? "⚡ Notable one-off expenses inside the total:" : "⚡ Заметные разовые траты внутри суммы:";
  const totalLabel = language === "en" ? "Notable total" : "Всего заметными";
  const countLine = items.totalCount > items.length
    ? (language === "en" ? `Shown ${items.length} of ${items.totalCount}` : `Показано ${items.length} из ${items.totalCount}`)
    : null;
  return [
    heading,
    ...items.map((item) => `• ${formatDate(item.date, language)} — ${escapeHtml(item.name)} — ${formatReportMoney(item.amount, currency, language)}`),
    ...(countLine ? [countLine] : []),
    `${totalLabel}: ${boldMoney(total ?? items.totalAmount ?? sum(items, "amount"), currency, language)}`
  ].join("\n");
}

function formatTopCategoriesBlock(items = [], currency, language, limit) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const heading = language === "en" ? "🏷️ Top categories:" : "🏷️ Главные категории:";
  return [
    heading,
    ...items.slice(0, limit).map((item, index) => `${index + 1}. ${escapeHtml(item.name)} — ${formatReportMoney(item.amount, currency, language)}`)
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

function formatComparisonLine(comparison = {}, language) {
  const labels = language === "en" ? enLabels : ruLabels;
  const pct = Math.abs(Number(comparison.percentDelta ?? 0));
  if (comparison.direction === "up") return labels.comparisonUp(pct);
  if (comparison.direction === "down") return labels.comparisonDown(pct);
  return labels.comparisonFlat;
}

function formatAverageLine(average, currency, language) {
  const labels = language === "en" ? enLabels : ruLabels;
  return `${labels.averageLabel} — ${formatReportMoney(average, currency, language)}/${labels.day}`;
}

function formatWeeklyTopCategories(items = [], topTwoShare, currency, language) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const labels = language === "en" ? enLabels : ruLabels;
  const lines = [labels.topCategoriesHeading];
  items.slice(0, 3).forEach((item, index) => {
    lines.push(`${index + 1}. ${escapeHtml(item.name)} — ${formatReportMoney(item.amount, currency, language)} · ${Math.round(Number(item.percent ?? 0))}%`);
  });
  if (topTwoShare != null) {
    lines.push(labels.topTwoShare(topTwoShare));
  }
  return lines.join("\n");
}

function formatLargestExpenses(items = [], currency, language) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const labels = language === "en" ? enLabels : ruLabels;
  const lines = [labels.largestExpensesHeading];
  items.slice(0, 5).forEach((item, index) => {
    lines.push(`${index + 1}. ${escapeHtml(item.name)} — ${formatReportMoney(item.amount, currency, language)}`);
  });
  return lines.join("\n");
}

function formatWhatChanged(changes = [], currency, language) {
  if (!Array.isArray(changes) || changes.length === 0) return null;
  const labels = language === "en" ? enLabels : ruLabels;
  const lines = [labels.whatChangedHeading];
  changes.slice(0, 3).forEach((change) => {
    lines.push(`• ${formatChangeLine(change, currency, language)}`);
  });
  return lines.join("\n");
}

function formatChangeLine(change, currency, language) {
  const labels = language === "en" ? enLabels : ruLabels;
  const name = escapeHtml(change.name);
  if (change.isNew) {
    return labels.changeNew(name, formatReportMoney(change.currentTotal, currency, language));
  }
  if (change.direction === "up") {
    return labels.changeUp(name, formatReportMoney(Math.abs(change.delta), currency, language));
  }
  return labels.changeDown(name, Math.abs(Number(change.percentDelta ?? 0)));
}

function formatNeedsAttention(needsAttention, currency, language) {
  if (!needsAttention || !Array.isArray(needsAttention.shown) || needsAttention.shown.length === 0) return null;
  const labels = language === "en" ? enLabels : ruLabels;
  const lines = [labels.needsAttentionHeading];
  if (Number(needsAttention.count ?? 0) > 1) {
    lines.push(`${labels.notMarkedTotal}: ${formatReportMoney(needsAttention.total, currency, language)}`);
  }
  for (const item of needsAttention.shown) {
    const dateLabel = formatDate(item.dueDate, language);
    lines.push(`${escapeHtml(item.name)} — ${formatReportMoney(item.amount, currency, language)}`);
    lines.push(item.overdue ? labels.stillUnpaid(dateLabel) : labels.notMarked(dateLabel));
  }
  if (Number(needsAttention.moreCount ?? 0) > 0) {
    lines.push(labels.morePayments(needsAttention.moreCount));
  }
  return lines.join("\n");
}

function formatPeriodLabel(period = {}, language) {
  if (!period.localStartDate || !period.localEndDate) return "";
  const start = dateParts(period.localStartDate);
  const end = dateParts(period.localEndDate);
  if (language === "en") {
    const startMonth = monthName(start.month, language);
    const endMonth = start.month === end.month ? "" : `${monthName(end.month, language)} `;
    return `${startMonth} ${start.day}–${endMonth}${end.day}`;
  }
  if (start.month === end.month) {
    return `${start.day}–${end.day} ${monthName(end.month, language)}`;
  }
  return `${start.day} ${monthName(start.month, language)} — ${end.day} ${monthName(end.month, language)}`;
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  averageLabel: "В среднем",
  day: "день",
  inside: "🧩 Внутри этой суммы",
  madeUp: "🧩 Из чего сложился месяц",
  plannedPaid: "Плановые оплаты",
  regular: "Остальные расходы",
  monthlyBudget: "💰 Бюджет месяца",
  monthlyPace: "📊 Темп месяца",
  everydaySpending: "Повседневные расходы",
  includingPlanned: "Всего с плановыми",
  topupLine: (money) => `➕ Бюджет пополнен на ${money}`,
  outsideLine: (money) => `🚧 Вне бюджета: ${money}`,
  comparisonUp: (pct) => `📈 На ${pct}% больше, чем неделей ранее`,
  comparisonDown: (pct) => `📈 На ${pct}% меньше, чем неделей ранее`,
  comparisonFlat: "📈 Примерно на уровне прошлой недели",
  topCategoriesHeading: "🏷️ Главные категории",
  topTwoShare: (share) => `Две главные категории составили <b>${share}% всех расходов недели</b>.`,
  largestExpensesHeading: "🧾 Самые большие расходы",
  whatChangedHeading: "🔄 Что изменилось",
  changeUp: (name, delta) => `На ${name} потрачено на ${delta} больше`,
  changeDown: (name, pct) => `Расходы на ${name} снизились на ${pct}%`,
  changeNew: (name, current) => `Появились расходы на ${name}: ${current}`,
  needsAttentionHeading: "⚠️ Требует внимания",
  notMarkedTotal: "Не отмечено",
  notMarked: (date) => `Оплата за ${date} не отмечена и не входит в расходы недели.`,
  stillUnpaid: (date) => `Оплата за ${date} всё ещё не отмечена.`,
  morePayments: (count) => `И ещё ${count} ${ruPluralPayments(count)}`,
  takeawayHeading: "💡 Главное за неделю",
  firstWeekLine: "Первая неделя учёта завершена. По мере накопления истории здесь появится сравнение расходов по неделям."
};

const enLabels = {
  weeklyTitle: "📊 Weekly summary",
  monthlyTitle: (month) => `🧾 ${month} is closed`,
  spent: "💸 Spent",
  average: "Average",
  averageLabel: "Daily average",
  day: "day",
  inside: "🧩 Inside this amount",
  madeUp: "🧩 What made up the month",
  plannedPaid: "Planned payments",
  regular: "Other expenses",
  monthlyBudget: "💰 Monthly budget",
  monthlyPace: "📊 Monthly pace",
  everydaySpending: "Everyday spending",
  includingPlanned: "Including planned payments",
  topupLine: (money) => `➕ Budget increased by ${money}`,
  outsideLine: (money) => `🚧 Outside budget: ${money}`,
  comparisonUp: (pct) => `📈 ${pct}% more than the previous week`,
  comparisonDown: (pct) => `📈 ${pct}% less than the previous week`,
  comparisonFlat: "📈 Roughly in line with the previous week",
  topCategoriesHeading: "🏷️ Top categories",
  topTwoShare: (share) => `The top two categories accounted for <b>${share}% of all spending this week</b>.`,
  largestExpensesHeading: "🧾 Largest expenses",
  whatChangedHeading: "🔄 What changed",
  changeUp: (name, delta) => `Spending on ${name} increased by ${delta}`,
  changeDown: (name, pct) => `Spending on ${name} decreased by ${pct}%`,
  changeNew: (name, current) => `New spending on ${name}: ${current}`,
  needsAttentionHeading: "⚠️ Needs attention",
  notMarkedTotal: "Not marked",
  notMarked: (date) => `The payment due on ${date} has not been marked as paid and is not included in this week's spending.`,
  stillUnpaid: (date) => `The payment due on ${date} is still not marked as paid.`,
  morePayments: (count) => `And ${count} more payment${count === 1 ? "" : "s"}`,
  takeawayHeading: "💡 This week's takeaway",
  firstWeekLine: "Your first week of tracking is complete. Weekly comparisons will appear as more history becomes available."
};

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function ruPluralPayments(count) {
  const n = Math.abs(Number(count) || 0);
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "оплата";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "оплаты";
  return "оплат";
}
