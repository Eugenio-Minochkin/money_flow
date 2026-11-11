import { MONTHLY_BUDGET_HIGH_USAGE_MIN_PCT } from "./reportAnalytics.js";

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
  const currency = report.currency ?? "THB";
  const partition = displayPartition(metrics, currency);
  const monthNum = Number(String(report.period?.periodKey ?? "").slice(5, 7)) || 1;

  const lines = [
    labels.monthlyTitle(monthNum),
    "",
    ...lineWithSecondary(
      `${labels.spent}: ${boldMoney(metrics.totalSpent, currency, language)}`,
      secondaryDisplayLine(metrics.display, "totalSpent", currency, language)
    )
  ];

  if (report.comparison?.available) {
    lines.push(formatMonthlyComparisonLine(report.comparison, language));
  }
  if (Number(metrics.totalSpent ?? 0) > 0) {
    lines.push(formatAverageLine(metrics.averagePerDay, currency, language));
  }

  pushOptional(lines, formatMonthlyBudgetBlock(report.budget, currency, language));
  pushOptional(lines, formatBreakdownBlock(partition, metrics, currency, language));
  pushOptional(lines, formatMonthlyTopCategories(report.topCategories, report.topTwoCategoryShare, currency, language));
  pushOptional(lines, formatLargestExpenses(report.largestExpenses, currency, language));
  if (report.comparison?.available) {
    pushOptional(lines, formatMonthlyWhatChanged(report.changes, currency, language));
  }
  pushOptional(lines, formatMonthlyPlannedBlock(report.plannedPayments, report.metrics?.plannedPaidTotal ?? partition.plannedPaidTotal, report.needsAttention, currency, language));
  if (report.takeaway) {
    pushOptional(lines, `${labels.monthlyTakeawayHeading}\n${escapeHtml(report.takeaway)}`);
  }
  if (report.firstMonth) {
    pushOptional(lines, labels.firstMonthLine);
  }
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

function monthInPrepositional(month, language) {
  if (language === "en") return monthName(month, language);
  const names = ["январе", "феврале", "марте", "апреле", "мае", "июне", "июле", "августе", "сентябре", "октябре", "ноябре", "декабре"];
  return names[Math.max(1, Math.min(12, Number(month))) - 1];
}

function formatMonthlyComparisonLine(comparison = {}, language) {
  const labels = language === "en" ? enLabels : ruLabels;
  const pct = Math.abs(Number(comparison.percentDelta ?? 0));
  const monthNum = Number(String(comparison.priorMonthKey ?? "").slice(5, 7)) || 1;
  const month = monthInPrepositional(monthNum, language);
  if (comparison.direction === "up") return labels.monthlyComparisonUp(pct, month);
  if (comparison.direction === "down") return labels.monthlyComparisonDown(pct, month);
  return labels.monthlyComparisonFlat(month);
}

function formatMonthlyBudgetBlock(budget = {}, currency, language) {
  if (!budget || Number(budget.amount ?? 0) <= 0) return null;
  const labels = language === "en" ? enLabels : ruLabels;
  const usedPct = Math.round(Number(budget.usedPercent ?? 0));
  const overAmount = Number(budget.overAmount ?? 0);
  const exceeded = overAmount > 0 || usedPct > 100;
  const lines = [labels.monthlyBudgetHeading];
  if (exceeded) {
    lines.push(...lineWithSecondary(
      labels.monthlyExceededLine(boldMoney(overAmount, currency, language)),
      secondaryDisplayLine(budget.display, "overAmount", currency, language, true)
    ));
    lines.push(labels.monthlyUsedPlannedPct(usedPct));
  } else {
    lines.push(usedPct >= MONTHLY_BUDGET_HIGH_USAGE_MIN_PCT ? labels.monthlyStatusAlmost : labels.monthlyStatusWithin);
    lines.push(labels.monthlyUsedOf(usedPct, boldMoney(budget.amount, currency, language)));
    lines.push(...lineWithSecondary(
      labels.monthlyRemainingLine(boldMoney(Number(budget.remaining ?? 0), currency, language)),
      secondaryDisplayLine(budget.display, "remaining", currency, language, true)
    ));
  }
  if (Number(budget.topupsTotal ?? 0) > 0) {
    lines.push(labels.monthlyTopupsLine(formatReportMoney(budget.topupsTotal, currency, language)));
  }
  return lines.join("\n");
}

function formatBreakdownBlock(partition = {}, metrics = {}, currency, language) {
  const labels = language === "en" ? enLabels : ruLabels;
  const planned = Number(partition.plannedPaidTotal ?? 0);
  if (!(planned > 0)) return null;
  const regular = Number(partition.regularTotal ?? 0);
  const total = planned + regular;
  const plannedPct = total > 0 ? Math.round((planned / total) * 100) : 0;
  const regularPct = Math.max(100 - plannedPct, 0);
  const regularAverage = metrics.regularAveragePerDay ?? metrics.averagePerDay ?? 0;
  const lines = [
    labels.monthlyBreakdownHeading,
    `${labels.monthlyPlannedLabel} — ${boldMoney(planned, currency, language)} · ${plannedPct}%`,
    `${labels.monthlyRegularLabel} — ${boldMoney(regular, currency, language)} · ${regularPct}%`,
    labels.monthlyExcludingPlannedAverage(formatReportMoney(regularAverage, currency, language))
  ];
  return lines.join("\n");
}

function formatMonthlyTopCategories(items = [], topTwoShare, currency, language) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const labels = language === "en" ? enLabels : ruLabels;
  const lines = [labels.topCategoriesHeading];
  items.slice(0, 5).forEach((item, index) => {
    lines.push(`${index + 1}. ${escapeHtml(item.name)} — ${formatReportMoney(item.amount, currency, language)} · ${Math.round(Number(item.percent ?? 0))}%`);
  });
  if (topTwoShare != null) {
    lines.push(labels.monthlyTopTwoShare(topTwoShare));
  }
  return lines.join("\n");
}

function formatMonthlyWhatChanged(changes = [], currency, language) {
  if (!Array.isArray(changes) || changes.length === 0) return null;
  const labels = language === "en" ? enLabels : ruLabels;
  const changeLabels = {
    changeUp: labels.monthlyChangeUp,
    changeDown: labels.monthlyChangeDown,
    changeNew: labels.monthlyChangeNew
  };
  const lines = [labels.monthlyWhatChangedHeading];
  changes.slice(0, 3).forEach((change) => {
    lines.push(`• ${formatChangeLine(change, currency, language, changeLabels)}`);
  });
  return lines.join("\n");
}

function formatMonthlyPlannedBlock(plannedPayments = [], paidTotal, needsAttention, currency, language) {
  if (!Array.isArray(plannedPayments) || plannedPayments.length === 0) return null;
  const labels = language === "en" ? enLabels : ruLabels;
  const paidCount = plannedPayments.filter((item) => item.paid).length;
  const lines = [
    labels.monthlyPlannedHeading,
    labels.monthlyMarkedPaid(paidCount, plannedPayments.length),
    labels.monthlyIncludedPaid(formatReportMoney(paidTotal ?? 0, currency, language))
  ];
  if (needsAttention && Array.isArray(needsAttention.shown) && needsAttention.shown.length > 0) {
    lines.push("");
    if (Number(needsAttention.count ?? 0) > 1) {
      lines.push(`${labels.notMarkedTotal}: ${formatReportMoney(needsAttention.total ?? 0, currency, language)}`);
    }
    for (const item of needsAttention.shown) {
      lines.push(`⚠️ ${escapeHtml(item.name)} — ${formatReportMoney(item.amount, currency, language)}`);
      lines.push(labels.monthlyStillUnpaid(formatDate(item.dueDate, language)));
    }
    if (Number(needsAttention.moreCount ?? 0) > 0) {
      lines.push(labels.morePayments(needsAttention.moreCount));
    }
  }
  return lines.join("\n");
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

function formatChangeLine(change, currency, language, changeLabels) {
  const labels = changeLabels ?? (language === "en" ? enLabels : ruLabels);
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
  monthlyTitle: (monthNum) => `🧾 Итоги ${monthName(monthNum, "ru")}`,
  spent: "💸 Потрачено",
  average: "В среднем",
  averageLabel: "В среднем",
  day: "день",
  topupLine: (money) => `➕ Бюджет пополнен на ${money}`,
  outsideLine: (money) => `🚧 Вне бюджета: ${money}`,
  comparisonUp: (pct) => `📈 На ${pct}% больше, чем неделей ранее`,
  comparisonDown: (pct) => `📈 На ${pct}% меньше, чем неделей ранее`,
  comparisonFlat: "📈 Примерно на уровне прошлой недели",
  topCategoriesHeading: "🏷️ Главные категории",
  topTwoShare: (share) => `Две главные категории составили <b>${share}% всех расходов недели</b>.`,
  largestExpensesHeading: "🧾 Самые большие расходы",
  whatChangedHeading: "🔄 Что изменилось",
  changeUp: (name, delta) => `${name} — на ${delta} больше`,
  changeDown: (name, pct) => `${name} — на ${pct}% меньше`,
  changeNew: (name, current) => `Новая категория: ${name} — ${current}`,
  needsAttentionHeading: "⚠️ Требует внимания",
  notMarkedTotal: "Не отмечено",
  notMarked: (date) => `Оплата за ${date} не отмечена и не входит в расходы недели.`,
  stillUnpaid: (date) => `Оплата за ${date} всё ещё не отмечена.`,
  morePayments: (count) => `И ещё ${count} ${ruPluralPayments(count)}`,
  takeawayHeading: "💡 Главное за неделю",
  firstWeekLine: "Первая неделя учёта завершена. По мере накопления истории здесь появится сравнение расходов по неделям.",
  monthlyComparisonUp: (pct, month) => `📈 На ${pct}% больше, чем в ${month}`,
  monthlyComparisonDown: (pct, month) => `📈 На ${pct}% меньше, чем в ${month}`,
  monthlyComparisonFlat: (month) => `📈 Примерно на уровне ${month}`,
  monthlyBudgetHeading: "🎯 Бюджет месяца",
  monthlyStatusWithin: "✅ В пределах бюджета",
  monthlyStatusAlmost: "⚠️ Бюджет почти использован",
  monthlyExceededLine: (money) => `Бюджет превышен на ${money}`,
  monthlyUsedOf: (pct, money) => `Использовано ${pct}% из ${money}`,
  monthlyUsedPlannedPct: (pct) => `Использовано ${pct}% запланированной суммы`,
  monthlyRemainingLine: (money) => `Осталось: ${money}`,
  monthlyTopupsLine: (money) => `Включая пополнения бюджета: ${money}`,
  monthlyBreakdownHeading: "🧩 Структура расходов",
  monthlyPlannedLabel: "Плановые оплаты",
  monthlyRegularLabel: "Остальные расходы",
  monthlyExcludingPlannedAverage: (money) => `Без плановых оплат — в среднем ${money}/день.`,
  monthlyTopTwoShare: (share) => `Две главные категории составили ${share}% всех расходов месяца.`,
  monthlyWhatChangedHeading: "🔄 Что изменилось",
  monthlyChangeUp: (name, delta) => `${name} — на ${delta} больше`,
  monthlyChangeDown: (name, pct) => `${name} — на ${pct}% меньше`,
  monthlyChangeNew: (name, current) => `Новая категория: ${name} — ${current}`,
  monthlyPlannedHeading: "📅 Плановые оплаты",
  monthlyMarkedPaid: (paid, total) => `✅ Отмечено ${paid} из ${total}`,
  monthlyIncludedPaid: (money) => `В расходы месяца включено ${money}`,
  monthlyStillUnpaid: (date) => `Оплата за ${date} всё ещё не отмечена и не входит в расходы месяца.`,
  monthlyTakeawayHeading: "💡 Главное за месяц",
  firstMonthLine: "Первый полный месяц учёта завершён. Сравнение появится после завершения следующего месяца."
};

const enLabels = {
  weeklyTitle: "📊 Weekly summary",
  monthlyTitle: (monthNum) => `🧾 ${monthName(monthNum, "en")} summary`,
  spent: "💸 Spent",
  average: "Average",
  averageLabel: "Daily average",
  day: "day",
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
  firstWeekLine: "Your first week of tracking is complete. Weekly comparisons will appear as more history becomes available.",
  monthlyComparisonUp: (pct, month) => `📈 ${pct}% more than in ${month}`,
  monthlyComparisonDown: (pct, month) => `📉 ${pct}% less than in ${month}`,
  monthlyComparisonFlat: (month) => `📈 Roughly in line with ${month}`,
  monthlyBudgetHeading: "🎯 Monthly budget",
  monthlyStatusWithin: "✅ Within budget",
  monthlyStatusAlmost: "⚠️ Budget almost fully used",
  monthlyExceededLine: (money) => `Budget exceeded by ${money}`,
  monthlyUsedOf: (pct, money) => `Used ${pct}% of ${money}`,
  monthlyUsedPlannedPct: (pct) => `Used ${pct}% of the planned amount`,
  monthlyRemainingLine: (money) => `Remaining: ${money}`,
  monthlyTopupsLine: (money) => `Including budget top-ups: ${money}`,
  monthlyBreakdownHeading: "🧩 Spending breakdown",
  monthlyPlannedLabel: "Planned payments",
  monthlyRegularLabel: "Other expenses",
  monthlyExcludingPlannedAverage: (money) => `Excluding planned payments, the daily average was ${money}.`,
  monthlyTopTwoShare: (share) => `The top two categories accounted for ${share}% of all spending this month.`,
  monthlyWhatChangedHeading: "🔄 What changed",
  monthlyChangeUp: (name, delta) => `${name} — ${delta} more`,
  monthlyChangeDown: (name, pct) => `${name} — ${pct}% less`,
  monthlyChangeNew: (name, current) => `New category: ${name} — ${current}`,
  monthlyPlannedHeading: "📅 Planned payments",
  monthlyMarkedPaid: (paid, total) => `✅ ${paid} of ${total} marked as paid`,
  monthlyIncludedPaid: (money) => `${money} included in this month's spending`,
  monthlyStillUnpaid: (date) => `The payment due on ${date} is still not marked as paid and is not included in this month's spending.`,
  monthlyTakeawayHeading: "💡 This month's takeaway",
  firstMonthLine: "Your first full month of tracking is complete. A comparison will appear after the next month is complete."
};

function ruPluralPayments(count) {
  const n = Math.abs(Number(count) || 0);
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "оплата";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "оплаты";
  return "оплат";
}
