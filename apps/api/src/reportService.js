import { isBotBlockedError } from "./releaseNotesService.js";
import { formatMonthlyReport, formatWeeklyReport } from "./reportFormat.js";
import { monthlyReportKeyboard, weeklyReportKeyboard } from "./reportKeyboards.js";
import {
  monthlyPeriodForSend,
  shouldSendMonthlyReportForUser,
  shouldSendWeeklyReportForUser,
  weeklyPeriodForSend
} from "./reportPeriods.js";
import { normalizeTimeZone, timeZoneMonthBounds } from "../../../packages/shared/src/time.js";

const ZERO_DECIMAL_DISPLAY_CURRENCIES = new Set(["THB", "RUB", "IDR", "BYN"]);

export function buildReportMetrics(input = {}) {
  const currency = input.currency ?? "THB";
  const expenses = Array.isArray(input.expenses) ? input.expenses : [];
  const paidPlannedPayments = Array.isArray(input.paidPlannedPayments) ? input.paidPlannedPayments : [];
  const budgetTopups = Array.isArray(input.budgetTopups) ? input.budgetTopups : [];
  const monthBaseline = money(input.monthBaseline);
  const plannedExpenseIds = new Set(
    paidPlannedPayments
      .map((payment) => payment.expense_id ?? payment.expenseId)
      .filter((id) => id != null)
      .map(String)
  );
  const totalExpenses = sumMoney(expenses, "amount_base");
  const totalSpent = roundMoney(totalExpenses + monthBaseline);
  const plannedPaidTotal = roundMoney(
    paidPlannedPayments.reduce((total, payment) => total + money(payment.amount_base ?? payment.amountBase), 0)
  );
  const explicitLargeOneOffTotal = roundMoney(
    expenses
      .filter((expense) => expense.budget_impact === "large_oneoff")
      .reduce((total, expense) => total + money(expense.amount_base), 0)
  );
  const largeTotal = roundMoney(
    expenses
      .filter((expense) => isDisplayLargeExpense(expense, plannedExpenseIds, input.largeThreshold))
      .reduce((total, expense) => total + money(expense.amount_base), 0)
  );
  const regularTotal = roundMoney(Math.max(totalSpent - plannedPaidTotal, 0));
  const dailyProjectionBase = roundMoney(Math.max(totalSpent - plannedPaidTotal - explicitLargeOneOffTotal, 0));
  const displayPartition = roundPartitionForDisplay({
    total: displayTotalFor(expenses, totalSpent, input.totalDisplay),
    planned: displayPlannedTotalFor(paidPlannedPayments, plannedPaidTotal),
    currency: input.displayCurrency ?? currency
  });
  const budgetTopupsTotal = roundMoney(
    budgetTopups.reduce((total, topup) => total + money(topup.amount_base ?? topup.amountBase), 0)
  );
  const outOfBudgetTotal = roundMoney(input.outOfBudgetTotal ?? 0);

  return {
    currency,
    totalSpent,
    plannedPaidTotal,
    regularTotal,
    largeTotal,
    explicitLargeOneOffTotal,
    dailyProjectionBase,
    budgetTopupsTotal,
    outOfBudgetTotal,
    showOutsideBudget: outOfBudgetTotal > 0,
    display: {
      currency: input.displayCurrency ?? currency,
      totalSpent: displayPartition.total,
      plannedPaidTotal: displayPartition.plannedPaidTotal,
      regularTotal: displayPartition.regularTotal
    }
  };
}

export function roundPartitionForDisplay({ total, planned, currency = "THB" }) {
  const roundedTotal = roundForCurrency(total, currency);
  const plannedPaidTotal = roundForCurrency(planned, currency);
  return {
    total: roundedTotal,
    plannedPaidTotal,
    regularTotal: roundForCurrency(roundedTotal - plannedPaidTotal, currency)
  };
}

export function createReportService(options = {}) {
  const repository = options.repository;
  const sendMessage = options.sendMessage ?? (async () => null);
  const miniAppUrl = options.miniAppUrl;
  const now = options.now ?? (() => new Date());

  return {
    repository,
    async runDueReports(input = {}) {
      const current = input.now ?? now();
      const dryRun = input.dryRun === true;
      const users = await repository.listReportCandidates();
      const summary = { checked: 0, eligible: 0, willSend: 0, sent: 0, failed: 0, skipped: 0 };

      for (const user of users) {
        summary.checked += 1;
        const dueReports = reportsDueForUser(user, current);
        if (dueReports.length === 0) continue;
        summary.eligible += 1;

        for (const due of dueReports) {
          const outcome = await deliverReportForUser(user, due.reportType, due.period, { dryRun, current });
          summary[outcome] = (summary[outcome] ?? 0) + 1;
        }
      }

      return summary;
    },
    async sendReportForUser(user, reportType, period, input = {}) {
      return deliverReportForUser(user, reportType, period, { ...input, current: input.current ?? now() });
    },
    async backfillMonthlyReport(periodKey, input = {}) {
      const dryRun = input.dryRun !== false;
      const users = await repository.listReportCandidates();
      const summary = { checked: users.length, eligible: 0, willSend: 0, sent: 0, failed: 0, skipped: 0 };
      for (const user of users) {
        const period = monthlyBackfillPeriod(periodKey, user.timezone);
        const outcome = await deliverReportForUser(user, "monthly", period, { dryRun, force: input.force === true, current: input.now ?? now() });
        summary[outcome] = (summary[outcome] ?? 0) + 1;
      }
      return summary;
    }
  };

  async function deliverReportForUser(user, reportType, period, input = {}) {
    const existing = await repository.getReportDelivery(user.id, reportType, period.periodKey);
    if (existing && input.force !== true) {
      if (["sent", "skipped", "pending"].includes(existing.status)) return "skipped";
    }

    if (input.dryRun === true) return "willSend";

    const report = await buildReportForDelivery(user, reportType, period, input.current);
    await repository.createReportDelivery({
      userId: user.id,
      reportType,
      periodKey: period.periodKey,
      periodStartUtc: period.periodStartUtc,
      periodEndUtc: period.periodEndUtc,
      timezoneUsed: period.timezoneUsed,
      status: "pending",
      generatedAt: report.generatedAt ?? input.current,
      metadata: deliveryMetadata(report)
    });
    await repository.recordAppEvent?.(user.id, `${reportType}_report_generated`, deliveryMetadata(report));

    try {
      const response = await sendMessage({
        chatId: Number(user.telegram_user_id),
        reportType,
        text: reportType === "monthly"
          ? formatMonthlyReport(report, { language: user.interface_language })
          : formatWeeklyReport(report, { language: user.interface_language }),
        replyMarkup: reportType === "monthly"
          ? monthlyReportKeyboard(miniAppUrl, Number(user.telegram_user_id), period.periodKey, user.interface_language)
          : weeklyReportKeyboard(miniAppUrl, Number(user.telegram_user_id), period.periodKey, user.interface_language)
      });
      await repository.markReportDeliverySent({
        userId: user.id,
        reportType,
        periodKey: period.periodKey,
        telegramMessageId: response?.message_id ?? response?.messageId ?? null,
        sentAt: input.current,
        metadata: deliveryMetadata(report)
      });
      await repository.recordAppEvent?.(user.id, `${reportType}_report_sent`, deliveryMetadata(report));
      return "sent";
    } catch (error) {
      const blocked = isBotBlockedError(error);
      const metadata = { ...deliveryMetadata(report), blocked };
      await repository.markReportDeliveryFailed({
        userId: user.id,
        reportType,
        periodKey: period.periodKey,
        errorCode: error.status ? String(error.status) : error.code ?? "send_failed",
        errorMessage: error.message,
        metadata
      });
      await repository.recordAppEvent?.(user.id, `${reportType}_report_failed`, metadata);
      if (blocked) await repository.markUserBotBlocked(user.id);
      return "failed";
    }
  }

  async function buildReportForDelivery(user, reportType, period, current) {
    if (typeof repository.buildReportDataForDelivery === "function") {
      return repository.buildReportDataForDelivery(user, reportType, period, current);
    }
    return {
      reportType,
      currency: user.base_currency ?? "THB",
      period,
      metrics: buildReportMetrics({ currency: user.base_currency ?? "THB" }),
      budget: { amount: 0, baseBudget: 0, topupsTotal: 0, remaining: 0 },
      plannedPayments: [],
      largeExpenses: [],
      budgetTopups: [],
      topCategories: [],
      insight: "",
      generatedAt: current
    };
  }
}

function reportsDueForUser(user, current) {
  const reports = [];
  if (shouldSendMonthlyReportForUser(current, user.timezone)) {
    reports.push({ reportType: "monthly", period: monthlyPeriodForSend(current, user.timezone) });
  }
  if (shouldSendWeeklyReportForUser(current, user.timezone)) {
    reports.push({ reportType: "weekly", period: weeklyPeriodForSend(current, user.timezone) });
  }
  return reports;
}

function deliveryMetadata(report) {
  const metrics = report.metrics ?? {};
  return {
    report_type: report.reportType,
    period_key: report.period?.periodKey ?? null,
    period_start: report.period?.periodStartUtc?.toISOString?.() ?? null,
    period_end: report.period?.periodEndUtc?.toISOString?.() ?? null,
    timezone_used: report.period?.timezoneUsed ?? null,
    total_spent: metrics.totalSpent ?? 0,
    budget_topups_total: metrics.budgetTopupsTotal ?? 0,
    planned_paid_total: metrics.plannedPaidTotal ?? 0,
    regular_total: metrics.regularTotal ?? 0,
    large_total: metrics.largeTotal ?? 0,
    out_of_budget_total: metrics.outOfBudgetTotal ?? 0
  };
}

function monthlyBackfillPeriod(periodKey, timeZoneValue) {
  const timeZone = normalizeTimeZone(timeZoneValue).timeZone;
  const bounds = timeZoneMonthBounds(periodKey, timeZone);
  const [yearText, monthText] = String(periodKey).split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    reportType: "monthly",
    periodKey,
    periodStartUtc: bounds.start,
    periodEndUtc: bounds.end,
    timezoneUsed: timeZone,
    localStartDate: `${yearText}-${monthText}-01`,
    localEndDate: `${yearText}-${monthText}-${String(daysInMonth).padStart(2, "0")}`
  };
}

function isDisplayLargeExpense(expense, plannedExpenseIds, largeThreshold) {
  if (expense.budget_impact === "large_oneoff") return true;
  if (plannedExpenseIds.has(String(expense.id))) return false;
  const threshold = Number(largeThreshold ?? 0);
  return threshold > 0 && money(expense.amount_base) >= threshold;
}

function displayTotalFor(expenses, totalSpent, provided) {
  if (provided != null) return money(provided);
  const displayTotal = expenses.reduce((total, expense) => total + money(expense.display?.amount), 0);
  return displayTotal > 0 ? displayTotal : totalSpent;
}

function displayPlannedTotalFor(payments, plannedPaidTotal) {
  const displayTotal = payments.reduce((total, payment) => total + money(payment.display?.amount), 0);
  return displayTotal > 0 ? displayTotal : plannedPaidTotal;
}

function sumMoney(rows, field) {
  return rows.reduce((total, row) => total + money(row?.[field]), 0);
}

function money(value) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

function roundMoney(value) {
  return Math.round((Number(value ?? 0) + Number.EPSILON) * 100) / 100;
}

function roundForCurrency(value, currency) {
  const decimals = ZERO_DECIMAL_DISPLAY_CURRENCIES.has(String(currency).toUpperCase()) ? 0 : 2;
  const factor = 10 ** decimals;
  return Math.round((Number(value ?? 0) + Number.EPSILON) * factor) / factor;
}
