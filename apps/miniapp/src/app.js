import { buildDashboardRequestPath, createApiClient, isOnboardingDashboardResponse } from "./apiClient.js";
import { categories, categoryColor, categoryLabel } from "./categories.js";
import { currencyOptions } from "./currencies.js";
import { resolveDraftSaveResponse, classifyConfirmOutcome } from "./draftSave.js";
import { buildDashboardCards, buildHeroMetric, renderBudgetTopupBreakdown, renderDashboardCards } from "./dashboardCards.js";
import {
  dateTimeLocal,
  escapeAttribute,
  escapeHtml,
  formatDate,
  formatDateOnly,
  formatMoney,
  moneyBase,
  moneyDisplay,
  moneyDisplaySigned,
  localDateKeyInTimeZone,
  setBaseCurrency
} from "./formatters.js";
import {
  buildCalendarMonth,
  canNavigateToMonth,
  buildHistoryRequestParams,
  createCalendarDraft,
  expenseCountLabel,
  formatCustomRangeLabel,
  groupByDay,
  historyFilterFromLaunchParams,
  periodTotal,
  selectRangeDate,
  shiftCalendarMonth
} from "./history.js";
import { createTranslator } from "./i18n.js";
import { inboxCountLabel, inboxDraftDescription, inboxDraftTotal, shouldShowInboxOnDashboard, updateFirstInboxItemCategory } from "./inbox.js";
import { buildReserveSettingsView } from "./reserveSettings.js";
import { runPlannedDisable } from "./plannedDisable.js";
import { paidPlannedPaymentUndoOccurrences, runPlannedPaymentUndo } from "./plannedPaymentUndo.js";
import { createPlannedRecreateSession, runPlannedRecreate } from "./plannedRecreate.js";
import {
  buildArchivedPlanView,
  collapsePlannedArchive,
  createPlannedArchiveState,
  expandPlannedArchive,
  invalidatePlannedArchive
} from "./plannedArchive.js";
import {
  buildPlannedOccurrences,
  calculatePlannedMonthSummary,
  defaultPlannedCurrency,
  dueOrOverduePlannedOccurrences,
  isPlannedPaid,
  nextUnpaidPlannedItem,
  parseDueDays,
  recurrenceLabel as plannedRecurrenceLabel,
  weekdayOptions as plannedWeekdayOptions
} from "./planned.js";
import { COMMON_TIMEZONES, detectBrowserTimeZone, normalizeSettingsTimeZone, shouldShowCurrentMonthBudgetOverride } from "./settings.js";

const params = new URLSearchParams(window.location.search);
const telegramUserId = params.get("telegramUserId") || window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
const draftId = params.get("draftId");

const percentNumber = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const FLIP_SELECTOR = "[data-flip-card]";
const FLIP_TOGGLE_SELECTOR = "[data-flip-toggle]";
const api = createApiClient();
let dashboardState = null;
let draftState = null;
let draftDirty = false;
let draftReturnTab = "dashboard";
let expenseReturnTab = "dashboard";
let historyState = [];
let inboxState = [];
let historyFilterState = historyFilterFromLaunchParams(params);
let skipNextHistoryTabLoad = false;
let historyCalendarDraft = null;
let currentLanguage = "en";
let translate = createTranslator(currentLanguage);
let currentTheme = "light";
let reserveSettingsExpanded = false;
let settingsBaseline = "";
let accountDeleted = false;
const plannedArchiveState = createPlannedArchiveState();

const deleteAccountStartButton = document.getElementById("deleteAccountStartButton");
const deleteAccountAdvanceButton = document.getElementById("deleteAccountAdvanceButton");
const deleteAccountCancelButton = document.getElementById("deleteAccountCancelButton");
const deleteAccountConfirmInput = document.getElementById("deleteAccountConfirmInput");
const deleteAccountConfirmButton = document.getElementById("deleteAccountConfirmButton");

const CURRENCY_MARKS = {
  THB: `<svg viewBox="0 0 30 20" role="img" aria-label="THB"><rect width="30" height="20" fill="#c6283c"/><rect y="3.2" width="30" height="13.6" fill="#fff"/><rect y="5.6" width="30" height="8.8" fill="#243a8f"/></svg>`,
  USD: `<svg viewBox="0 0 30 20" role="img" aria-label="USD"><rect width="30" height="20" fill="#fff"/><g fill="#b22234"><rect y="0" width="30" height="1.54"/><rect y="3.08" width="30" height="1.54"/><rect y="6.16" width="30" height="1.54"/><rect y="9.24" width="30" height="1.54"/><rect y="12.32" width="30" height="1.54"/><rect y="15.4" width="30" height="1.54"/><rect y="18.48" width="30" height="1.52"/></g><rect width="12.8" height="10.8" fill="#3c3b6e"/></svg>`,
  RUB: `<svg viewBox="0 0 30 20" role="img" aria-label="RUB"><rect width="30" height="20" fill="#fff"/><rect y="6.67" width="30" height="6.66" fill="#1f57a4"/><rect y="13.33" width="30" height="6.67" fill="#d52b1e"/></svg>`,
  IDR: `<svg viewBox="0 0 30 20" role="img" aria-label="IDR"><rect width="30" height="10" fill="#ce1126"/><rect y="10" width="30" height="10" fill="#fff"/></svg>`,
  EUR: `<svg viewBox="0 0 30 20" role="img" aria-label="EUR"><rect width="30" height="20" fill="#1f57a4"/><circle cx="15" cy="10" r="5.4" fill="none" stroke="#f6c745" stroke-width="1.5" stroke-dasharray="1 2"/></svg>`,
  BYN: `<svg viewBox="0 0 30 20" role="img" aria-label="BYN"><rect width="30" height="20" fill="#c8313e"/><rect y="13.2" width="30" height="6.8" fill="#238b45"/><rect width="6" height="20" fill="#fff"/><path d="M1 2h4M1 6h4M1 10h4M1 14h4M1 18h4" stroke="#c8313e" stroke-width="1"/></svg>`,
  GEL: `<svg viewBox="0 0 30 20" role="img" aria-label="GEL"><rect width="30" height="20" fill="#fff"/><rect x="13" width="4" height="20" fill="#d52b1e"/><rect y="8" width="30" height="4" fill="#d52b1e"/><g stroke="#d52b1e" stroke-width="1.4"><path d="M6 4v4M4 6h4M24 4v4M22 6h4M6 14v4M4 16h4M24 14v4M22 16h4"/></g></svg>`
};

if (window.Telegram?.WebApp) {
  window.Telegram.WebApp.ready();
  window.Telegram.WebApp.expand();
}

document.querySelector("#settingsForm").addEventListener("submit", saveSettings);
document.querySelector("#reserveForm")?.addEventListener("submit", saveReserve);
document.querySelector("#disableReserveButton")?.addEventListener("click", disableReserve);
document.querySelector("#reserveSummaryButton")?.addEventListener("click", () => {
  reserveSettingsExpanded = !reserveSettingsExpanded;
  renderReserveSettings();
});
document.querySelector("#reserveRecurringInput")?.addEventListener("change", renderReserveSettings);
document.querySelector("#saveCurrentMonthBudgetButton")?.addEventListener("click", saveCurrentMonthBudget);
document.querySelector("#historySearchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  loadHistory();
});
document.querySelector("#togglePlannedForm").addEventListener("click", () => {
  const form = document.querySelector("#plannedForm");
  form.classList.toggle("hidden");
  if (!form.classList.contains("hidden")) form.scrollIntoView({ behavior: "smooth", block: "start" });
});
document.querySelector("#plannedArchiveToggle")?.addEventListener("click", async () => {
  if (plannedArchiveState.expanded) {
    collapsePlannedArchive(plannedArchiveState);
    renderPlannedArchive();
    return;
  }
  plannedArchiveState.expanded = true;
  try {
    await refreshPlannedArchive();
  } catch {
    // The archive owns its retryable error state and must not block the active plan list.
  }
});
document.querySelectorAll("[data-tab]").forEach((button) => {
  button.addEventListener("click", () => switchTab(button.dataset.tab));
});
document.querySelector("#settingsForm")?.addEventListener("input", updateSettingsDirtyState);
document.querySelector("#settingsForm")?.addEventListener("change", updateSettingsDirtyState);
document.querySelector("#baseCurrencyInput").addEventListener("change", updateSettingsDecorations);
document.querySelector("#displayCurrencyInput").addEventListener("change", updateSettingsDecorations);
document.querySelector("#interfaceLanguageInput").addEventListener("change", (event) => applyLanguage(event.target.value));
document.querySelector("#interfaceThemeInput").addEventListener("change", (event) => applyTheme(event.target.value));
document.querySelector("#detectTimezoneButton")?.addEventListener("click", detectTimezone);
document.querySelector("#openHistoryInboxButton")?.addEventListener("click", () => switchTab("history"));
document.querySelector("#openAllHistoryButton")?.addEventListener("click", () => switchTab("history"));
document.querySelectorAll("[data-export-period]").forEach((button) => {
  button.addEventListener("click", () => requestExpenseExport(button.dataset.exportPeriod));
});
deleteAccountStartButton?.addEventListener("click", requestAccountDeletion);
deleteAccountAdvanceButton?.addEventListener("click", advanceAccountDeletion);
deleteAccountCancelButton?.addEventListener("click", cancelAccountDeletion);
deleteAccountConfirmInput?.addEventListener("input", () => {
  deleteAccountConfirmButton.disabled = deleteAccountConfirmInput.value !== "DELETE";
});
deleteAccountConfirmButton?.addEventListener("click", confirmAccountDeletion);
document.querySelectorAll("[data-history-period]").forEach((chip) => {
  chip.addEventListener("click", () => selectHistoryPeriod(chip.dataset.historyPeriod));
});
document.querySelector("#openHistoryDatePicker")?.addEventListener("click", openHistoryDatePicker);
document.querySelector("#closeHistoryDatePicker")?.addEventListener("click", closeHistoryDatePicker);
document.querySelector("#historyDateBackdrop")?.addEventListener("click", closeHistoryDatePicker);
document.querySelector("#historyCalendarPrevious")?.addEventListener("click", () => moveHistoryCalendar(-1));
document.querySelector("#historyCalendarNext")?.addEventListener("click", () => moveHistoryCalendar(1));
document.querySelector("#historyCalendarGrid")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-calendar-date]");
  if (!button || button.disabled) return;
  historyCalendarDraft = {
    ...historyCalendarDraft,
    ...selectRangeDate(historyCalendarDraft, button.dataset.calendarDate)
  };
  renderHistoryCalendar();
});
document.querySelector("#applyHistoryPeriodButton")?.addEventListener("click", applyHistoryCustomRange);
document.querySelector("#resetHistoryPeriodButton")?.addEventListener("click", resetHistoryPeriod);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDashboardTooltips();
  if (event.key === "Escape" && !document.querySelector("#historyDateSheet")?.classList.contains("hidden")) {
    closeHistoryDatePicker();
  }
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(FLIP_SELECTOR)) closeDashboardTooltips();
  const popover = document.querySelector("#plannedDuePopover");
  if (!popover || popover.classList.contains("hidden")) return;
  if (popover.contains(event.target) || event.target.closest("[data-planned-menu]")) return;
  popover.classList.add("hidden");
});

applyLanguage(currentLanguage);
load().catch(showError);

async function load() {
  if (!telegramUserId) throw new Error("No Telegram user id. Open Mini App from the bot.");
  renderPlannedForm();
  const dashboard = await loadDashboard();
  if (isOnboardingDashboardResponse(dashboard)) return;
  await loadHistory();
  if (params.get("view") === "history") {
    skipNextHistoryTabLoad = true;
    switchTab("history");
  }
  if (params.get("view") === "settings") switchTab("settings");
  if (draftId) await openDraftInline(draftId, {
    returnTab: "dashboard",
    row: document.querySelector(`[data-inbox-location="dashboard"][data-draft-row="${draftId}"]`)
      ?? document.querySelector(`[data-draft-row="${draftId}"]`)
  });
}

async function loadDashboard() {
  if (accountDeleted) return;
  const data = await api(buildDashboardRequestPath(telegramUserId, window.location.search));
  if (accountDeleted) return;
  if (isOnboardingDashboardResponse(data)) {
    renderOnboardingState(data.user);
    return data;
  }
  dashboardState = data;
  setBaseCurrency(data.user?.base_currency ?? data.snapshot?.baseCurrency ?? "THB");
  renderSettings(data.user);
  renderPlannedForm();
  renderSnapshot(data.snapshot);
  renderPlannedNotice(data.plannedExpenses ?? []);
  renderAnalytics(data.snapshot, data.analytics ?? {});
  renderTopCategories(data.topCategories ?? [], data.snapshot.month);
  renderPlannedMonthSummary(data.plannedExpenses ?? []);
  renderPlannedExpenses(data.plannedExpenses ?? []);
  renderLatest(data.latestExpenses ?? []);
  await renderClosedReserveEvents(data.closedReserveEvents ?? []);
  if (data.recurringReserveBlocked) showToast(t("reserve.blocked"));
  return data;
}

function renderOnboardingState(user) {
  applyLanguage(user?.interface_language ?? "en");
  document.querySelector("#onboardingState")?.classList.remove("hidden");
  for (const id of ["dashboardTab", "historyTab", "planTab", "settingsTab"]) {
    document.getElementById(id)?.classList.add("hidden");
  }
  document.querySelector(".bottom-tabs")?.classList.add("hidden");
  document.querySelector("#onboardingOpenBotButton")?.addEventListener("click", () => {
    window.Telegram?.WebApp?.close();
  }, { once: true });
}

function renderAnalytics(snapshot, analytics) {
  renderMonthlyForecast(snapshot, analytics);
  renderOtherWarning(analytics.otherCategoryWarning);
  renderLargestExpenses(analytics);
  renderTopTags(analytics.topTags ?? []);
  renderHeatmap(analytics.dailyHeatmap ?? [], snapshot.daysInMonth ?? 30);
}

function renderOtherWarning(warning) {
  const notice = document.querySelector("#otherWarning");
  const badge = document.querySelector("#otherWarningBadge");
  if (!warning?.active) {
    notice.classList.add("hidden");
    notice.innerHTML = "";
    badge?.classList.add("hidden");
    return;
  }
  notice.classList.remove("hidden");
  badge?.classList.remove("hidden");
  notice.innerHTML = `
    <div class="notice-title">
      <span>${currentLanguage === "ru" ? `Категория “Другое” уже ${warning.percent}% месяца` : `Other is already ${warning.percent}% of the month`}</span>
      <strong>${moneyBase(warning.total)}</strong>
    </div>
    <div class="expense-meta">${currentLanguage === "ru" ? "Стоит разобрать эти траты, чтобы статистика была полезнее." : "Review these expenses to make the stats more useful."}</div>
  `;
}

function renderLargestExpenses(analytics) {
  const list = document.querySelector("#largestExpenses");
  const items = [
    analytics.largestWeek ? [t("dashboard.week"), analytics.largestWeek] : null,
    analytics.largestMonth ? [t("dashboard.month"), analytics.largestMonth] : null
  ].filter(Boolean);
  if (!items.length) {
    list.innerHTML = `<div class="empty">${t("dashboard.largestEmpty")}</div>`;
    return;
  }
  list.innerHTML = items.map(([label, expense]) => `
    <article class="expense-row" style="--category-color: ${categoryColor(expense.category_slug)}">
      <div class="expense-main">
        <div class="expense-title">${escapeHtml(label)} · ${escapeHtml(expense.description)}</div>
        <div class="expense-meta">${formatDate(expense.spent_at, currentLanguage, userTimeZone())} · ${escapeHtml(categoryLabel(expense.category_slug, currentLanguage))}</div>
      </div>
      <div class="expense-amount">${moneyBase(expense.amount_base)}
        <em>${moneyDisplay(expense.display?.amount, expense.display?.currency)}</em>
      </div>
    </article>
  `).join("");
}

function renderTopTags(items) {
  const list = document.querySelector("#topTags");
  if (!items.length) {
    list.innerHTML = `<div class="empty">${t("dashboard.tagsEmpty")}</div>`;
    return;
  }
  list.innerHTML = items.map((item) => `
    <div class="tag-chip">
      <span>#${escapeHtml(item.tag)}</span>
      <strong>${moneyBase(item.total)}</strong>
      <em>${moneyDisplay(item.display?.amount, item.display?.currency)}</em>
    </div>
  `).join("");
}

function renderHeatmap(items, daysInMonth) {
  const grid = document.querySelector("#dailyHeatmap");
  const byDay = new Map(items.map((item) => [Number(item.day), Number(item.total)]));
  const max = Math.max(...items.map((item) => Number(item.total)), 1);
  grid.innerHTML = Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const total = byDay.get(day) ?? 0;
    const intensity = Math.min(total / max, 1);
    return `<div class="heatmap-day" style="--heat: ${intensity}" title="${day}: ${moneyBase(total)}">${day}</div>`;
  }).join("");
}

function renderMonthlyForecast(snapshot, analytics) {
  const forecast = Number(snapshot.forecastMonthTotal ?? 0);
  const monthlyBudget = Number(snapshot.monthlyBudget ?? 0);
  const spentSoFar = Number(snapshot.month ?? 0);
  const daysInMonth = Number(snapshot.daysInMonth ?? 0) || 0;
  const averageDailySpending = Number(
    snapshot.averageDailyRegularSpending ?? (daysInMonth > 0 ? forecast / daysInMonth : 0)
  );
  const difference = forecast - monthlyBudget;
  const displayCurrency = snapshot.display?.currency;
  const showDisplay = Boolean(displayCurrency) && displayCurrency !== snapshot.baseCurrency;
  const displayText = (value) => (showDisplay ? moneyDisplay(value, displayCurrency) : "");
  const displayForecast = Number(snapshot.display?.forecastMonthTotal ?? 0);
  const displayBudget = Number(snapshot.display?.monthlyBudget ?? 0);
  const displayAverageDaily = Number(
    snapshot.display?.averageDailyRegularSpending ?? (daysInMonth > 0 ? displayForecast / daysInMonth : 0)
  );
  const perDay = t("monthlyForecast.perDay");
  const hasBudget = Number.isFinite(monthlyBudget) && monthlyBudget > 0;
  const roundedDifference = Math.round(difference * 100) / 100;
  const isOverBudget = roundedDifference > 0;
  const forecastSection = document.querySelector("#monthlyForecast");

  setText("#forecastSummaryTotal", t("monthlyForecast.summaryTotal", { amount: moneyBase(forecast) }));
  setText("#forecastSummaryStatus", hasBudget
    ? (isOverBudget
      ? t("monthlyForecast.summaryAboveBudget", { amount: moneyBase(Math.abs(difference)) })
      : t("monthlyForecast.summaryWithinBudget", { amount: moneyBase(Math.abs(difference)) }))
    : t("monthlyForecast.withinBudget"));
  if (forecastSection) forecastSection.dataset.state = isOverBudget ? "danger" : "good";
  setText("#forecastAmount", moneyBase(forecast));
  setText("#forecastAmountDisplay", displayText(displayForecast));
  setText("#forecastExplanation", t("monthlyForecast.explanation", { spentSoFar: moneyBase(spentSoFar) }));

  setText("#forecastBudget", moneyBase(monthlyBudget));
  setText("#forecastBudgetDisplay", displayText(displayBudget));

  const diffRow = document.querySelector("#forecastDiffRow");
  diffRow.classList.remove("good", "bad", "neutral");
  if (isOverBudget) {
    diffRow.classList.add("bad");
    setText("#forecastDiff", t("monthlyForecast.aboveBudget", { amount: moneyBase(Math.abs(difference)) }));
  } else {
    diffRow.classList.add("good");
    setText("#forecastDiff", t("monthlyForecast.withinBudgetWithLeft", { amount: moneyBase(Math.abs(difference)) }));
  }
  setText("#forecastDiffDisplay", displayText(Math.abs(displayForecast - displayBudget)));

  setText("#forecastAvgPace", `${moneyBase(averageDailySpending)}${perDay}`);
  setText("#forecastAvgPaceDisplay", showDisplay ? `${moneyDisplay(displayAverageDaily, displayCurrency)}${perDay}` : "");

  const weekComparison = analytics?.weekComparison ?? {};
  const weekDelta = Number(weekComparison.delta ?? NaN);
  const weekRow = document.querySelector("#forecastWeekRow");
  weekRow.classList.remove("good", "bad", "neutral");
  if (Number.isFinite(weekDelta)) {
    if (weekDelta > 0) weekRow.classList.add("bad");
    else if (weekDelta < 0) weekRow.classList.add("good");
    else weekRow.classList.add("neutral");
    setText("#forecastWeek", `${weekDelta > 0 ? "+" : ""}${moneyBase(weekDelta)}`);
    setText("#forecastWeekDisplay", showDisplay ? moneyDisplaySigned(weekComparison.display?.delta, weekComparison.display?.currency) : "");
  } else {
    weekRow.classList.add("neutral");
    setText("#forecastWeek", t("monthlyForecast.noData"));
    setText("#forecastWeekDisplay", "");
  }

  document.querySelector("#forecastBudgetRow").classList.toggle("hidden", !hasBudget);
  document.querySelector("#forecastDiffRow").classList.toggle("hidden", !hasBudget);
}

async function loadHistory() {
  if (accountDeleted) return;
  const search = document.querySelector("#historySearch").value.trim();
  const params = buildHistoryRequestParams(telegramUserId, search, historyFilterState);
  const [data, inbox] = await Promise.all([
    api(`/api/expenses?${params.toString()}`),
    api(`/api/drafts?telegramUserId=${encodeURIComponent(telegramUserId)}&status=inbox`)
  ]);
  if (accountDeleted) return;
  historyState = data.expenses ?? [];
  inboxState = inbox.drafts ?? [];
  renderDashboardInboxDrafts(inboxState);
  renderInboxDrafts(inboxState);
  renderHistory(historyState);
  renderHistoryPeriodSummary(historyState);
}

function selectHistoryPeriod(period) {
  historyFilterState = { period, monthKey: "", fromDate: "", toDate: "" };
  updateHistoryFilterChips();
  loadHistory().catch(showError);
}

function applyHistoryCustomRange() {
  const fromDate = historyCalendarDraft?.startDate;
  const toDate = historyCalendarDraft?.endDate;
  if (!fromDate || !toDate) {
    return;
  }
  historyFilterState = { period: "custom", monthKey: "", fromDate, toDate };
  closeHistoryDatePicker();
  updateHistoryFilterChips();
  loadHistory().catch(showError);
}

function resetHistoryPeriod() {
  historyFilterState = { period: "month", monthKey: "", fromDate: "", toDate: "" };
  closeHistoryDatePicker();
  updateHistoryFilterChips();
  loadHistory().catch(showError);
}

function updateHistoryFilterChips() {
  document.querySelectorAll("[data-history-period]").forEach((chip) => {
    const active = chip.dataset.historyPeriod === historyFilterState.period;
    chip.classList.toggle("active", active);
    chip.setAttribute("aria-pressed", String(active));
  });
  const dateButton = document.querySelector("#openHistoryDatePicker");
  const customActive = historyFilterState.period === "custom";
  dateButton?.classList.toggle("active", customActive);
  dateButton?.setAttribute("aria-pressed", String(customActive));
  updateHistoryFilterCurrent();
}

function openHistoryDatePicker() {
  historyCalendarDraft = createCalendarDraft(historyFilterState, localTodayYmd());
  document.querySelector("#historyDateBackdrop")?.classList.remove("hidden");
  document.querySelector("#historyDateSheet")?.classList.remove("hidden");
  document.body.classList.add("history-date-sheet-open");
  renderHistoryCalendar();
  document.querySelector("#closeHistoryDatePicker")?.focus();
}

function closeHistoryDatePicker() {
  document.querySelector("#historyDateBackdrop")?.classList.add("hidden");
  document.querySelector("#historyDateSheet")?.classList.add("hidden");
  document.body.classList.remove("history-date-sheet-open");
  historyCalendarDraft = null;
  document.querySelector("#openHistoryDatePicker")?.focus();
}

function moveHistoryCalendar(delta) {
  if (!historyCalendarDraft) return;
  const nextMonth = shiftCalendarMonth(historyCalendarDraft.visibleMonth, delta);
  if (!canNavigateToMonth(nextMonth, localTodayYmd())) return;
  historyCalendarDraft.visibleMonth = nextMonth;
  renderHistoryCalendar();
}

function renderHistoryCalendar() {
  if (!historyCalendarDraft) return;
  const today = localTodayYmd();
  const cells = buildCalendarMonth(historyCalendarDraft.visibleMonth, today, historyCalendarDraft);
  const monthDate = new Date(
    Number(historyCalendarDraft.visibleMonth.slice(0, 4)),
    Number(historyCalendarDraft.visibleMonth.slice(5, 7)) - 1,
    1
  );
  setText("#historyCalendarMonth", new Intl.DateTimeFormat(
    currentLanguage === "ru" ? "ru-RU" : "en-US",
    { month: "long", year: "numeric" }
  ).format(monthDate));

  const grid = document.querySelector("#historyCalendarGrid");
  grid.innerHTML = cells.map((cell, index) => {
    const classes = [
      "history-calendar__day",
      cell.isStart ? "is-start" : "",
      cell.isEnd ? "is-end" : "",
      cell.isInRange ? "is-in-range" : "",
      cell.date === today ? "is-today" : ""
    ].filter(Boolean).join(" ");
    const label = new Intl.DateTimeFormat(
      currentLanguage === "ru" ? "ru-RU" : "en-US",
      { day: "numeric", month: "long", year: "numeric" }
    ).format(new Date(Number(cell.date.slice(0, 4)), Number(cell.date.slice(5, 7)) - 1, cell.day));
    const offset = index === 0 ? ` style="grid-column-start:${cell.weekdayIndex + 1}"` : "";
    return `<button type="button" class="${classes}" data-calendar-date="${cell.date}" aria-label="${escapeAttribute(label)}"${offset}${cell.disabled ? " disabled" : ""}>${cell.day}</button>`;
  }).join("");

  const selection = historyCalendarDraft.startDate
    ? formatCustomRangeLabel(historyCalendarDraft.startDate, historyCalendarDraft.endDate, currentLanguage)
    : t("history.selectedPeriod");
  setText("#historyDateSelection", selection);
  const applyButton = document.querySelector("#applyHistoryPeriodButton");
  if (applyButton) applyButton.disabled = !historyCalendarDraft.startDate;
  const nextMonth = shiftCalendarMonth(historyCalendarDraft.visibleMonth, 1);
  const nextButton = document.querySelector("#historyCalendarNext");
  if (nextButton) nextButton.disabled = !canNavigateToMonth(nextMonth, today);

  const weekdayLabels = currentLanguage === "ru"
    ? ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
    : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  document.querySelectorAll(".history-calendar__weekdays span").forEach((element, index) => {
    element.textContent = weekdayLabels[index];
  });
}

function localTodayYmd() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function updateHistoryFilterCurrent() {
  const current = document.querySelector("#historyFilterCurrent");
  if (!current) return;
  current.textContent = historyPeriodLabel();
}

function historyPeriodLabel() {
  const period = historyFilterState.period;
  if (period === "custom" && historyFilterState.fromDate && historyFilterState.toDate) {
    return formatCustomRangeLabel(historyFilterState.fromDate, historyFilterState.toDate, currentLanguage);
  }
  const key = {
    today: "history.today",
    yesterday: "history.yesterday",
    last7: "history.last7",
    previous_month: "history.previousMonth",
    month: "history.thisMonth"
  }[period] ?? "history.thisMonth";
  return t(key);
}

function historyPeriodTitle() {
  const period = historyFilterState.period;
  if (period === "custom" && historyFilterState.fromDate && historyFilterState.toDate) {
    return t("history.total.custom", {
      range: formatCustomRangeLabel(historyFilterState.fromDate, historyFilterState.toDate, currentLanguage)
    });
  }
  const key = {
    today: "history.total.today",
    yesterday: "history.total.yesterday",
    last7: "history.total.last7",
    previous_month: "history.total.previousMonth",
    month: "history.total.month"
  }[period] ?? "history.total.month";
  return t(key);
}

function renderHistoryPeriodSummary(expenses) {
  const summary = document.querySelector("#historyPeriodSummary");
  if (!summary) return;
  const total = periodTotal(expenses);
  const count = expenses.length;
  const title = historyPeriodTitle();
  summary.innerHTML = `
    <div class="history-summary-card">
      <span class="history-summary-label">${escapeHtml(title)}</span>
      <strong class="history-summary-amount">${escapeHtml(moneyBase(total))}</strong>
      <small class="history-summary-meta">${escapeHtml(expenseCountLabel(count, currentLanguage))}</small>
    </div>
  `;
}

async function loadDraft(id, options = {}) {
  const data = await api(`/api/drafts/${id}?telegramUserId=${encodeURIComponent(telegramUserId)}`);
  draftState = data.draft;
  draftReturnTab = options.returnTab ?? "dashboard";
  renderDraftEditor(draftState);
}

function switchTab(tab) {
  if (accountDeleted) return;
  document.querySelector("#dashboardTab").classList.toggle("hidden", tab !== "dashboard");
  document.querySelector("#planTab").classList.toggle("hidden", tab !== "plan");
  document.querySelector("#historyTab").classList.toggle("hidden", tab !== "history");
  document.querySelector("#settingsTab").classList.toggle("hidden", tab !== "settings");
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  if (tab === "history") {
    if (skipNextHistoryTabLoad) {
      skipNextHistoryTabLoad = false;
      return;
    }
    loadHistory().catch(showError);
  }
}

function renderSnapshot(snapshot) {
  setBaseCurrency(snapshot.baseCurrency ?? dashboardState?.user?.base_currency ?? "THB");
  const heroMetric = buildHeroMetric(snapshot, {
    t,
    moneyBase,
    moneyDisplay
  });
  const hero = document.querySelector(".hero-metric");
  if (hero) hero.dataset.state = heroMetric.state;
  setText("#heroTitle", heroMetric.title);
  setText("#safeToSpend", heroMetric.amount);
  setText("#safeToSpendDisplay", heroMetric.display);
  setText("#heroHint", heroMetric.hint);
  setText("#heroSpentLabel", heroMetric.spentLabel);
  setText("#heroSpentValue", heroMetric.spent);
  setText("#heroMonthLabel", heroMetric.monthLabel);
  setText("#heroMonthValue", heroMetric.monthValue);
  const heroProgress = document.querySelector("#heroProgress");
  if (heroProgress) {
    heroProgress.style.width = `${heroMetric.progress.percent}%`;
    heroProgress.dataset.state = heroMetric.progress.state;
  }
  setText("#heroTooltipText", heroMetric.tooltip);
  const heroDetails = document.querySelector("#heroTooltip");
  if (heroDetails) heroDetails.innerHTML = renderHeroDetails(snapshot, dashboardState?.currentMonthBudget);
  const heroToggle = document.querySelector("#heroDetailsToggle");
  heroToggle?.setAttribute("aria-label", t("dashboard.hero.why"));
  heroToggle && (heroToggle.textContent = t("dashboard.hero.why"));
  bindHeroDetails();
  setText("#budgetPlanSummary", t("dashboard.budgetPlanSummary", {
    free: moneyBase(snapshot.freeRemaining ?? 0),
    planned: moneyBase(snapshot.plannedRemaining ?? 0)
  }));
  renderDashboardCards(document.querySelector("#dashboardCards"), buildDashboardCards(snapshot, {
    t,
    moneyBase,
    moneyDisplay,
    percent: (value) => `${percentNumber.format(Number(value ?? 0))}%`
  }));
  renderBudgetTopupBreakdown(document.querySelector("#budgetTopupBreakdown"), dashboardState?.currentMonthBudget, {
    t,
    moneyBase,
    formatDate: (value) => formatDateOnly(value)
  });
  bindDashboardTooltips();
}

function renderHeroDetails(snapshot, currentMonthBudget) {
  const rows = [
    ["dashboard.hero.baseBudget", currentMonthBudget?.baseBudget],
    ["dashboard.hero.topups", currentMonthBudget?.topupsTotal ? `+${moneyBase(currentMonthBudget.topupsTotal)}` : null],
    ["dashboard.hero.monthBudget", snapshot.monthlyBudget],
    ["dashboard.spent", snapshot.month],
    ["dashboard.hero.planned", snapshot.plannedRemaining],
    ["dashboard.hero.reserve", snapshot.reserve?.amount],
    ["dashboard.hero.free", snapshot.freeRemaining],
    ["dashboard.hero.dayPlan", snapshot.dayPlanLimit]
  ].filter(([, value]) => value != null).map(([label, value]) => `
    <div class="hero-metric__detail-row"><span>${escapeHtml(t(label))}</span><strong>${escapeHtml(typeof value === "string" ? value : moneyBase(value))}</strong></div>`);
  return rows.join("");
}

function bindHeroDetails() {
  const toggle = document.querySelector("#heroDetailsToggle");
  const panel = document.querySelector("#heroTooltip");
  if (!toggle || !panel || toggle.dataset.bound === "true") return;
  toggle.dataset.bound = "true";
  toggle.addEventListener("click", () => {
    const open = panel.hasAttribute("hidden");
    panel.toggleAttribute("hidden", !open);
    toggle.setAttribute("aria-expanded", String(open));
  });
}

function bindDashboardTooltips() {
  document.querySelectorAll(FLIP_SELECTOR).forEach((card) => {
    if (card.dataset.flipBound === "true") return;
    card.dataset.flipBound = "true";
    const button = card.querySelector(FLIP_TOGGLE_SELECTOR);
    card.addEventListener("click", (event) => {
      if (event.target.closest(FLIP_TOGGLE_SELECTOR)) return;
      toggleDashboardTooltip(card);
    });
    button?.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleDashboardTooltip(card);
    });
    button?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleDashboardTooltip(card);
    });
  });
}

function toggleDashboardTooltip(card) {
  const isOpen = card.classList.contains("is-flipped");
  closeDashboardTooltips();
  if (isOpen) return;
  setDashboardCardFlipped(card, true);
}

function closeDashboardTooltips() {
  document.querySelectorAll(`${FLIP_SELECTOR}.is-flipped`).forEach((card) => {
    setDashboardCardFlipped(card, false);
  });
}

function setDashboardCardFlipped(card, isFlipped) {
  card.classList.toggle("is-flipped", isFlipped);
  const button = card.querySelector(FLIP_TOGGLE_SELECTOR);
  const front = card.querySelector("[data-flip-front]");
  const back = card.querySelector("[data-flip-back]");
  button?.setAttribute("aria-expanded", String(isFlipped));
  front?.setAttribute("aria-hidden", String(isFlipped));
  back?.setAttribute("aria-hidden", String(!isFlipped));
  if (isFlipped) back?.focus?.({ preventScroll: true });
}

function renderSettings(user) {
  currentLanguage = user.interface_language ?? "en";
  currentTheme = user.interface_theme ?? "light";
  applyTheme(currentTheme);
  setBaseCurrency(user.base_currency ?? "THB");
  applyLanguage(currentLanguage);
  document.querySelector("#budgetInput").value = Math.round(Number(user.monthly_budget_amount ?? 45000));
  const currentMonthBudgetForm = document.querySelector("#currentMonthBudgetForm");
  const showCurrentMonthBudgetOverride = shouldShowCurrentMonthBudgetOverride(dashboardState?.currentMonthBudget, new Date(), userTimeZone(user));
  currentMonthBudgetForm?.classList.toggle("hidden", !showCurrentMonthBudgetOverride);
  if (showCurrentMonthBudgetOverride) {
    document.querySelector("#currentMonthBudgetInput").value = Math.round(Number(dashboardState.currentMonthBudget.amount));
  }
  document.querySelector("#weeklyBudgetInput").value = user.weekly_budget_amount == null ? "" : Math.round(Number(user.weekly_budget_amount));
  document.querySelector("#baseCurrencyInput").value = user.base_currency ?? "THB";
  document.querySelector("#displayCurrencyInput").value = user.display_currency ?? "USD";
  document.querySelector("#interfaceLanguageInput").value = currentLanguage;
  document.querySelector("#interfaceThemeInput").value = currentTheme;
  renderTimezoneOptions(user.timezone);
  document.querySelector("#usdThbRateInput").value = Number(user.usd_thb_rate ?? 32.65);
  document.querySelector("#dailyReminderInput").checked = user.daily_entry_reminder_enabled !== false;
  const reserve = dashboardState?.reserveInstance;
  const template = dashboardState?.reserveTemplate;
  document.querySelector("#reserveAmountInput").value = ["active", "disabled"].includes(reserve?.status)
    ? Math.round(Number(reserve.reserve_amount))
    : "";
  document.querySelector("#reserveTitleInput").value = reserve?.title ?? "";
  document.querySelector("#reserveRecurringInput").checked = template?.is_active === true;
  document.querySelector("#reserveScopeInput").value = template?.is_active === true
    ? "current_and_future"
    : "current";
  renderReserveSettings();
  updateSettingsDecorations();
  setSettingsDirtyBaseline();
}

function renderReserveSettings() {
  const reserve = dashboardState?.reserveInstance ?? null;
  const template = dashboardState?.reserveTemplate ?? null;
  const currency = dashboardState?.user?.base_currency ?? dashboardState?.snapshot?.baseCurrency ?? "THB";
  const view = buildReserveSettingsView({
    reserve,
    reserveSummary: dashboardState?.snapshot?.reserve ?? null,
    template: {
      ...template,
      is_active: document.querySelector("#reserveRecurringInput")?.checked === true
    },
    currency,
    isExpanded: reserveSettingsExpanded,
    t,
    moneyBase
  });
  setOptionalText("#reserveSummaryTitle", view.title);
  setOptionalText("#reserveSummaryMeta", view.meta);
  setOptionalText("#reserveSummaryStatus", view.status);

  const summaryButton = document.querySelector("#reserveSummaryButton");
  summaryButton?.setAttribute("aria-expanded", String(view.isExpanded));
  summaryButton?.classList.toggle("reserve-summary--expanded", view.isExpanded);

  const disabledNote = document.querySelector("#reserveDisabledNote");
  if (disabledNote) {
    disabledNote.textContent = view.disabledNote;
    disabledNote.classList.toggle("hidden", !view.disabledNote || view.isExpanded);
  }

  document.querySelector("#reserveForm")?.classList.toggle("hidden", !view.isExpanded);
  document.querySelector("#reserveScopeField")?.classList.toggle("hidden", !view.showScope);
  document.querySelector("#disableReserveButton")?.classList.toggle("hidden", !view.showDisable);
}

function renderPlannedMonthSummary(items) {
  const summary = dashboardState?.plannedMonthSummary ?? calculatePlannedMonthSummary(items);
  const baseCurrency = dashboardState?.user?.base_currency ?? dashboardState?.snapshot?.baseCurrency ?? "THB";
  const total = plannedSummaryMoneyParts(summary.total, baseCurrency, summary.display.total, summary.display.currency);
  const paid = plannedSummaryMoneyParts(summary.paid, baseCurrency, summary.display.paid, summary.display.currency);
  const remaining = plannedSummaryMoneyParts(summary.remaining, baseCurrency, summary.display.remaining, summary.display.currency);

  setHtml("#plannedReserveTotal", plannedSummaryMoneyHtml(total));
  setHtml("#plannedReservePaidRemaining", currentLanguage === "ru"
    ? `${plannedSummaryRowHtml("Оплачено", paid)}${plannedSummaryRowHtml("Осталось", remaining)}`
    : `${plannedSummaryRowHtml("Paid", paid)}${plannedSummaryRowHtml("Remaining", remaining)}`);
}

function plannedSummaryMoneyParts(baseAmount, baseCurrency, displayAmount, displayCurrency) {
  return {
    base: moneyBase(baseAmount, baseCurrency),
    display: displayCurrency && displayCurrency !== baseCurrency
      ? moneyDisplay(displayAmount, displayCurrency)
      : ""
  };
}

function plannedSummaryMoneyHtml(parts) {
  return parts.display ? `${parts.base} <em>· ${parts.display}</em>` : parts.base;
}

function plannedSummaryRowHtml(label, parts) {
  return `
    <div class="planned-summary-row">
      <span class="planned-summary-row__label">${label}</span>
      <span class="planned-summary-row__amount">${plannedSummaryMoneyHtml(parts)}</span>
    </div>
  `;
}

function renderPlannedNotice(items) {
  const notice = document.querySelector("#plannedNotice");
  const entries = dueOrOverduePlannedOccurrences(items);
  if (!entries.length) {
    const next = nextUnpaidPlannedItem(items);
    if (!next) {
      notice.classList.add("hidden");
      notice.innerHTML = "";
      return;
    }
    notice.classList.remove("hidden");
    notice.innerHTML = plannedFutureRowHtml(next);
    return;
  }
  notice.classList.remove("hidden");
  const hasToday = entries.some((entry) => entry.isToday);
  const hasOverdue = entries.some((entry) => !entry.isToday);
  const titleKey = hasToday && hasOverdue
    ? "plan.paymentsDueTitle"
    : hasOverdue ? "plan.overduePaymentsTitle" : "plan.paymentsDueTodayTitle";
  const rows = entries.map((entry) => plannedDueRowHtml(entry, titleKey)).join("");
  notice.innerHTML = `<div class="planned-due-list${hasOverdue ? " planned-due-list--overdue" : ""}">${rows}</div>`;
  bindPlannedActions(notice, items);
}

function plannedFutureRowHtml(entry) {
  const item = entry.item;
  const occurrenceDate = entry.occurrence?.occurrence_date ?? entry.date;
  const metaParts = [
    formatDateOnly(occurrenceDate, currentLanguage, userTimeZone()),
    moneyBase(item.amount_base ?? item.amount)
  ];
  const displayText = moneyDisplay(item.display?.amount, item.display?.currency);
  if (displayText && item.display?.currency && String(item.display.currency).toUpperCase() !== String(item.base_currency ?? "").toUpperCase()) {
    metaParts.push(displayText);
  }
  return `
    <article class="planned-due-row planned-due-row--compact planned-due-row--future">
      <span class="planned-due-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M8 3v4m8-4v4M8 11h8"/></svg></span>
      <div class="planned-due-main">
        <span class="planned-due-label">${t("plan.nextPlanned")}</span>
        <strong class="planned-due-title">${escapeHtml(item.description)}</strong>
        <em class="planned-due-meta">${escapeHtml(metaParts.join(" · "))}</em>
      </div>
    </article>
  `;
}

function plannedDueRowHtml(entry, titleKey) {
  const { item, occurrence, isToday } = entry;
  const dateLabel = isToday
    ? t("plan.dueToday")
    : t("plan.wasDue", { date: formatDateOnly(occurrence.occurrence_date, currentLanguage, userTimeZone()) });
  const displayCurrency = item.display?.currency;
  const displayAmount = item.display?.amount;
  const baseAmount = moneyBase(item.amount_base ?? item.amount);
  const metaParts = [dateLabel, baseAmount];
  const displayText = moneyDisplay(displayAmount, displayCurrency);
  if (displayText && displayCurrency && String(displayCurrency).toUpperCase() !== String(item.base_currency ?? "").toUpperCase()) {
    metaParts.push(displayText);
  }
  const labelKey = titleKey ?? "plan.paymentsDueTodayTitle";
  const payAttributes = `data-pay-planned="${escapeAttribute(item.id)}" data-occurrence-date="${escapeAttribute(occurrence.occurrence_date)}"`;
  return `
    <article class="planned-due-row planned-due-row--compact">
      <span class="planned-due-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M8 3v4m8-4v4M8 11h8"/></svg></span>
      <div class="planned-due-main">
        <span class="planned-due-label">${t(labelKey)}</span>
        <strong class="planned-due-title">${escapeHtml(item.description)}</strong>
        <em class="planned-due-meta">${escapeHtml(metaParts.join(" · "))}</em>
      </div>
      <button type="button" class="planned-due-pay" ${payAttributes}>${t("actions.pay")}</button>
    </article>
  `;
}

function openPlannedDueMenu(item, anchor) {
  const popover = document.querySelector("#plannedDuePopover");
  if (!popover) return;
  popover.innerHTML = `
    <button type="button" data-edit-planned="${escapeAttribute(item.id)}">${t("actions.edit")}</button>
    <button type="button" data-open-plan-tab>${t("actions.openPlan")}</button>
  `;
  popover.classList.remove("hidden");
  popover.dataset.plannedId = item.id;
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    const popoverWidth = 160;
    const left = Math.min(rect.right, window.innerWidth - popoverWidth - 8);
    popover.style.top = `${rect.bottom + 4}px`;
    popover.style.left = `${Math.max(8, left)}px`;
  }
}

function renderTopCategories(items, monthTotal) {
  const list = document.querySelector("#topCategories");
  if (!items.length) {
    list.innerHTML = `<div class="empty">${t("history.noCategories")}</div>`;
    return;
  }
  list.innerHTML = items.map((item) => {
    const total = Number(item.total);
    const percent = monthTotal > 0 ? Math.round((total / monthTotal) * 100) : 0;
    return `
      <div class="bar-row" style="--category-color: ${categoryColor(item.category_slug)}">
        <div class="bar-row-top">
          <span>${escapeHtml(categoryLabel(item.category_slug, currentLanguage))}</span>
          <strong>${moneyBase(total)} · ${percent}%</strong>
        </div>
        <div class="bar-row-display">${moneyDisplay(item.display?.amount, item.display?.currency)}</div>
        <div class="bar-track"><div class="bar-fill" style="width: ${Math.min(percent, 100)}%"></div></div>
      </div>
    `;
  }).join("");
}

function renderLatest(expenses) {
  const list = document.querySelector("#latestExpenses");
  if (!expenses.length) {
    list.innerHTML = `<div class="empty">${t("history.noExpenses")}</div>`;
    return;
  }
  list.innerHTML = expenses.slice(0, 3).map(dashboardExpenseRow).join("");
}

function dashboardExpenseRow(expense) {
  const amount = expense.amount_original ?? expense.amount_base ?? expense.amount ?? 0;
  const currency = expense.currency_original
    ?? expense.base_currency
    ?? dashboardState?.snapshot?.baseCurrency
    ?? dashboardState?.user?.base_currency
    ?? "THB";
  return `
    <article class="dashboard-expense-row" style="--category-color: ${categoryColor(expense.category_slug)}">
      <span class="dashboard-expense-icon" aria-hidden="true">${dashboardCategoryIcon(expense.category_slug)}</span>
      <div class="dashboard-expense-main">
        <strong>${escapeHtml(expense.description)}</strong>
        <span>${formatDate(expense.spent_at, currentLanguage, userTimeZone())}</span>
      </div>
      <div class="dashboard-expense-amount">
        <strong>${formatMoney(amount, currency)}</strong>
        <em>${moneyDisplay(expense.display?.amount, expense.display?.currency)}</em>
      </div>
    </article>
  `;
}

function dashboardCategoryIcon(slug) {
  const icons = {
    food_cafe: '<path d="M5 8h11v5a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5z"/><path d="M16 10h2a2 2 0 0 1 0 4h-2M7 5h7"/>',
    groceries: '<path d="M5 9h14l-1 11H6z"/><path d="M9 9a3 3 0 0 1 6 0"/>',
    transport: '<rect x="4" y="5" width="16" height="13" rx="3"/><path d="M7 9h10M7 14h10"/><circle cx="8" cy="19" r="1"/><circle cx="16" cy="19" r="1"/>',
    health: '<path d="M12 21s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.6-7 10-7 10z"/><path d="M9 13h6m-3-3v6"/>',
    sport_activities: '<path d="m7 5 3 3-4 4-3-3zm10 0-3 3 4 4 3-3zM9 15h6m-5-7h4"/>',
    home: '<path d="m4 11 8-7 8 7v9h-5v-6H9v6H4z"/>',
    travel: '<path d="M4 16 20 8l-6 12-3-5zM11 15l-3-3"/>',
    subscriptions: '<rect x="5" y="3" width="14" height="18" rx="3"/><path d="M9 7h6m-6 4h6m-6 4h4"/>',
    education: '<path d="m3 9 9-5 9 5-9 5z"/><path d="M7 12v5c3 2 7 2 10 0v-5"/>',
    gifts_help: '<rect x="4" y="9" width="16" height="11" rx="2"/><path d="M12 9v11M3 9h18V6H3zM12 6c-4 0-4-4-1-4 2 0 1 4 1 4zm0 0c4 0 4-4 1-4-2 0-1 4-1 4z"/>',
    entertainment: '<path d="M7 4h10l2 16-7-3-7 3z"/><circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/><path d="M9 14h6"/>',
    gear: '<path d="M6 7h12l2 13H4z"/><path d="M9 7a3 3 0 0 1 6 0"/>'
  };
  const content = icons[slug] ?? '<circle cx="12" cy="12" r="8"/><path d="M8 12h8m-4-4v8"/>';
  return `<svg viewBox="0 0 24 24" focusable="false">${content}</svg>`;
}

function renderHistory(expenses) {
  const list = document.querySelector("#historyList");
  const savedHeading = document.querySelector("#historySavedHeading");
  if (!expenses.length) {
    const searching = document.querySelector("#historySearch")?.value.trim();
    list.innerHTML = `<div class="empty">${escapeHtml(searching ? t("history.empty") : t("history.periodEmpty"))}</div>`;
    savedHeading?.classList.add("hidden");
    return;
  }

  savedHeading?.classList.remove("hidden");
  const groups = groupByDay(expenses);
  list.innerHTML = groups.map((group) => `
    <section class="history-day">
      <div class="history-day-heading">
        <h3>${escapeHtml(group.label)}</h3>
        <strong>${moneyBase(group.total)}</strong>
      </div>
      ${group.items.map(expenseRow).join("")}
    </section>
  `).join("");
  bindExpenseActions(list, expenses);
}

function renderInboxDrafts(drafts) {
  const block = document.querySelector("#inboxBlock");
  const list = document.querySelector("#inboxDrafts");
  const title = document.querySelector("#inboxTitle");
  if (!drafts.length) {
    block.classList.add("hidden");
    list.innerHTML = "";
    return;
  }
  block.classList.remove("hidden");
  title.textContent = inboxCountLabel(drafts.length, currentLanguage);
  list.innerHTML = drafts.map((draft) => {
    const total = inboxDraftTotal(draft);
    const description = inboxDraftDescription(draft);
    return `
      <article class="expense-row" style="--category-color: #b84d7a">
        <div class="expense-main">
          <div class="expense-title">${escapeHtml(description)}</div>
          <div class="expense-meta">${formatDate(draft.created_at, currentLanguage, userTimeZone())} · ${draft.items.length} ${t("history.rows")} · ${moneyBase(total)}</div>
          <div class="button-row inbox-category-row">
            ${inboxCategoryButtons(draft)}
          </div>
        </div>
        <div class="expense-actions">
          <div class="button-row compact">
            <button type="button" data-confirm-draft="${draft.id}">${t("actions.confirm")}</button>
            <button type="button" class="ghost-button" data-open-draft="${draft.id}">${t("actions.open")}</button>
            <button type="button" class="danger-button" data-cancel-draft="${draft.id}">${t("actions.cancel")}</button>
          </div>
        </div>
      </article>
    `;
  }).join("");
  bindInboxActions(list);
}

function renderDashboardInboxDrafts(drafts) {
  const block = document.querySelector("#dashboardInboxBlock");
  const list = document.querySelector("#dashboardInboxDrafts");
  const title = document.querySelector("#dashboardInboxTitle");
  if (!shouldShowInboxOnDashboard(drafts)) {
    block.classList.add("hidden");
    list.innerHTML = "";
    return;
  }
  block.classList.remove("hidden");
  title.textContent = inboxCountLabel(drafts.length, currentLanguage);
  list.innerHTML = drafts.slice(0, 2).map((draft) => {
    const total = inboxDraftTotal(draft);
    const description = inboxDraftDescription(draft);
    return `
      <article class="expense-row inbox-draft-row" data-inbox-location="dashboard" data-draft-row="${draft.id}" style="--category-color: #b84d7a">
        <div class="expense-main">
          <div class="expense-title">${escapeHtml(description)}</div>
          <div class="expense-meta">${formatDate(draft.created_at, currentLanguage, userTimeZone())} · ${draft.items.length} ${t("history.rows")} · ${moneyBase(total)}</div>
          <div class="button-row inbox-category-row">
            ${inboxCategoryButtons(draft)}
          </div>
        </div>
        <div class="expense-actions">
          <div class="button-row compact">
            <button type="button" data-confirm-draft="${draft.id}">${t("actions.confirm")}</button>
            <button type="button" class="ghost-button" data-open-draft="${draft.id}">${t("actions.open")}</button>
            <button type="button" class="danger-button" data-cancel-draft="${draft.id}">${t("actions.cancel")}</button>
          </div>
        </div>
      </article>
    `;
  }).join("");
  bindInboxActions(list);
}

function inboxCategoryButtons(draft) {
  const first = draft.items?.[0];
  if (!first) return "";
  const quickCategories = [
    ["food_cafe", currentLanguage === "ru" ? "Еда" : "Food"],
    ["transport", currentLanguage === "ru" ? "Транспорт" : "Transport"],
    ["health", currentLanguage === "ru" ? "Здоровье" : "Health"],
    ["sport_activities", currentLanguage === "ru" ? "Спорт" : "Sport"],
    ["other", currentLanguage === "ru" ? "Другое" : "Other"]
  ];
  return quickCategories.map(([slug, label]) => `
    <button type="button" class="ghost-button ${first.category_slug === slug ? "active-chip" : ""}" data-inbox-draft="${draft.id}" data-inbox-category="${slug}">
      ${escapeHtml(label)}
    </button>
  `).join("");
}

function bindInboxActions(container) {
  container.querySelectorAll("[data-open-draft]").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest(".expense-row");
      await openDraftInline(button.dataset.openDraft, {
        returnTab: row?.dataset.inboxLocation ?? "history",
        row
      });
    });
  });
  container.querySelectorAll("[data-confirm-draft]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/drafts/${button.dataset.confirmDraft}/confirm`, { method: "POST", body: { telegramUserId } });
      await loadDashboard();
      await loadHistory();
      showToast(t("toast.draftConfirmed"));
    });
  });
  container.querySelectorAll("[data-inbox-category]").forEach((button) => {
    button.addEventListener("click", async () => {
      const draft = inboxState.find((item) => String(item.id) === button.dataset.inboxDraft);
      if (!draft) return;
      const items = updateFirstInboxItemCategory(draft, button.dataset.inboxCategory);
      await api(`/api/drafts/${draft.id}`, { method: "PATCH", body: { telegramUserId, items } });
      await loadHistory();
      showToast(t("toast.categoryUpdated"));
    });
  });
  container.querySelectorAll("[data-cancel-draft]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!window.confirm(t("confirmations.closeWithoutSaving"))) return;
      await api(`/api/drafts/${button.dataset.cancelDraft}`, { method: "DELETE", body: { telegramUserId } });
      await loadHistory();
      showToast(t("toast.draftCanceled"));
    });
  });
}

async function openDraftInline(id, options = {}) {
  await loadDraft(id, { returnTab: options.returnTab ?? "dashboard" });
  const section = document.querySelector("#draftEditorSection");
  const row = options.row ?? document.querySelector(`[data-draft-row="${id}"]`);
  if (row && section) {
    row.after(section);
    section.dataset.inlineDraftId = String(id);
  }
  section?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function expenseRow(expense) {
  const impactLabel = budgetImpactLabel(expense.budget_impact);
  return `
    <article class="expense-row" style="--category-color: ${categoryColor(expense.category_slug)}">
      <div class="expense-main">
        <div class="expense-title">${escapeHtml(expense.description)}</div>
        ${impactLabel ? `<div class="expense-meta">${impactLabel}</div>` : ""}
        <div class="expense-meta">${formatDate(expense.spent_at, currentLanguage, userTimeZone())} · ${escapeHtml(categoryLabel(expense.category_slug, currentLanguage))}</div>
      </div>
      <div class="expense-actions">
        <div class="expense-amount">${formatMoney(expense.amount_original, expense.currency_original)}
          <em>${moneyDisplay(expense.display?.amount, expense.display?.currency)}</em>
        </div>
        <div class="button-row compact">
          <button type="button" class="ghost-button" data-edit-expense="${expense.id}">${t("actions.edit")}</button>
          <button type="button" class="danger-button" data-delete-expense="${expense.id}">${t("actions.delete")}</button>
        </div>
      </div>
    </article>
  `;
}

function budgetImpactLabel(value) {
  if (value === "planned") return currentLanguage === "ru" ? "🧾 Плановая" : "🧾 Planned";
  if (value === "large_oneoff") return currentLanguage === "ru" ? "📦 Крупная" : "📦 Large";
  return "";
}

function bindExpenseActions(container, expenses) {
  container.querySelectorAll("[data-edit-expense]").forEach((button) => {
    button.addEventListener("click", () => {
      const expense = expenses.find((item) => String(item.id) === button.dataset.editExpense);
      renderExpenseEditor(expense, { returnTab: "history" });
    });
  });
  container.querySelectorAll("[data-delete-expense]").forEach((button) => {
    button.addEventListener("click", async () => {
      const expense = expenses.find((item) => String(item.id) === button.dataset.deleteExpense);
      if (!window.confirm(currentLanguage === "ru" ? `Удалить расход "${expense.description}"?` : `Delete expense "${expense.description}"?`)) return;
      await api(`/api/expenses/${expense.id}`, { method: "DELETE", body: { telegramUserId, language: currentLanguage } });
      await loadDashboard();
      await loadHistory();
      showToast(t("toast.expenseDeleted"));
    });
  });
}

function renderPlannedForm(item = {}, { mode = "create", sourcePlannedExpenseId = null } = {}) {
  const form = document.querySelector("#plannedForm");
  const dueDays = Array.isArray(item.due_days) && item.due_days.length ? item.due_days.join(", ") : (item.due_day ?? "");
  const plannedCurrency = defaultPlannedCurrency(item, dashboardState?.user?.base_currency ?? "THB");
  const startsOn = mode === "recreate" ? localDateKeyInTimeZone(new Date(), userTimeZone()) : null;
  const sourceDueDate = item.due_date ? String(item.due_date).slice(0, 10) : "";
  const dueDate = mode === "recreate" && sourceDueDate <= startsOn ? "" : sourceDueDate;
  const title = mode === "recreate" ? t("plan.createAgain") : mode === "edit" ? t("plan.saveExisting") : t("plan.addPlanned");
  const submitLabel = mode === "recreate" ? t("plan.createAgain") : mode === "edit" ? t("plan.saveExisting") : t("plan.saveNew");
  const recreateSession = mode === "recreate" ? createPlannedRecreateSession() : null;
  form.innerHTML = `
    <h3>${title}</h3>
    ${mode === "recreate" ? `
      <label>
        <span>${t("plan.startsOn")}</span>
        <input name="planned-starts_on" type="date" value="${startsOn}" min="${startsOn}" required />
      </label>
    ` : ""}
    <div class="field-grid">
      <label>
        <span>${t("forms.description")}</span>
        <input name="planned-description" value="${escapeAttribute(item.description ?? "")}" placeholder="${currentLanguage === "ru" ? "ChatGPT, аренда, английский" : "ChatGPT, rent, English"}" required />
      </label>
      <label>
        <span>${t("forms.amount")}</span>
        <input name="planned-amount" type="number" min="0.01" step="0.01" value="${item.amount ?? ""}" required />
      </label>
    </div>
    <div class="field-grid">
      <label>
        <span>${t("forms.currency")}</span>
        <select name="planned-currency">${currencyOptions(plannedCurrency, option)}</select>
      </label>
      <label>
        <span>${t("plan.recurrence")}</span>
        <select name="planned-recurrence">
          ${option("monthly", item.recurrence, t("plan.monthly"))}
          ${option("weekly", item.recurrence, t("plan.weekly"))}
          ${option("twice_monthly", item.recurrence, t("plan.twiceMonthly"))}
          ${option("one_off", item.recurrence, t("plan.oneOff"))}
        </select>
      </label>
    </div>
    <div class="field-grid">
      <label>
        <span>${t("forms.category")}</span>
        <select name="planned-category_slug">${categories.map(([slug]) => option(slug, item.category_slug, categoryLabel(slug, currentLanguage))).join("")}</select>
      </label>
      <label data-recurrence-field="monthly">
        <span>${t("plan.dayOfMonth")}</span>
        <input name="planned-due_day" type="number" min="1" max="31" value="${item.due_day ?? ""}" />
      </label>
      <label data-recurrence-field="twice_monthly">
        <span>${t("plan.daysOfMonth")}</span>
        <input name="planned-due_days" value="${escapeAttribute(dueDays)}" placeholder="4, 18" />
      </label>
      <label data-recurrence-field="weekly">
        <span>${t("plan.weekday")}</span>
        <select name="planned-weekday">${weekdayOptions(item.weekday)}</select>
      </label>
      <label data-recurrence-field="one_off">
        <span>${t("plan.dueDate")}</span>
        <input name="planned-due_date" type="date" value="${dueDate}" />
      </label>
    </div>
    <label>
      <span>${t("forms.tagsComma")}</span>
      <input name="planned-tags" value="${escapeAttribute((item.tags ?? []).join(", "))}" />
    </label>
    <div class="button-row">
      <button type="submit">${submitLabel}</button>
      <button type="button" class="ghost-button" id="resetPlannedForm">${t("plan.reset")}</button>
      <button type="button" class="ghost-button" id="cancelPlannedForm">${t("actions.close")}</button>
    </div>
  `;
  form.onsubmit = (event) => savePlanned(event, {
    mode,
    plannedId: mode === "edit" ? item.id : null,
    sourcePlannedExpenseId,
    recreateSession
  });
  form.querySelector("#resetPlannedForm").addEventListener("click", () => renderPlannedForm());
  form.querySelector("#cancelPlannedForm").addEventListener("click", closeAndResetPlannedForm);
  form.querySelector('[name="planned-recurrence"]').addEventListener("change", syncPlannedRecurrenceFields);
  syncPlannedRecurrenceFields();
}

function syncPlannedRecurrenceFields() {
  const recurrence = input("planned-recurrence")?.value ?? "monthly";
  document.querySelectorAll("[data-recurrence-field]").forEach((field) => {
    field.classList.toggle("hidden", field.dataset.recurrenceField !== recurrence);
  });
}

function renderPlannedExpenses(items) {
  const list = document.querySelector("#plannedExpenses");
  if (!items.length) {
    list.innerHTML = `<div class="empty">${t("plan.noPlanned")}</div>`;
    return;
  }
  list.innerHTML = items.map((item) => {
    const paid = isPlannedPaid(item);
    const progress = plannedPaymentProgressLabel(item);
    const undoButtons = paidPlannedPaymentUndoOccurrences(item)
      .map((occurrenceDate) => {
        const date = formatDateOnly(`${occurrenceDate}T12:00:00.000Z`, currentLanguage, "UTC");
        return `<button type="button" class="ghost-button" data-undo-planned="${escapeAttribute(item.id)}" data-occurrence-date="${escapeAttribute(occurrenceDate)}">${escapeHtml(t("actions.undoPayment", { date }))}</button>`;
      })
      .join("");
    return `
    <article class="expense-row" style="--category-color: ${categoryColor(item.category_slug)}">
      <div class="expense-main">
        <div class="expense-title">${escapeHtml(item.description)}</div>
        <div class="expense-meta">${recurrenceLabel(item)} · ${escapeHtml(categoryLabel(item.category_slug, currentLanguage))}${progress ? ` · ${progress}` : ""}</div>
      </div>
      <div class="expense-actions">
        <div class="expense-amount">${formatMoney(item.amount, item.currency)}
          <em>${moneyDisplay(item.display?.amount, item.display?.currency)}</em>
        </div>
        <div class="button-row compact">
          <button type="button" data-pay-planned="${item.id}"${paid ? " disabled" : ""}>${paid ? t("actions.paid") : t("actions.pay")}</button>
          <button type="button" class="ghost-button" data-edit-planned="${item.id}">${t("actions.edit")}</button>
          <button type="button" class="danger-button" data-delete-planned="${item.id}">${t("actions.disable")}</button>
        </div>
        ${undoButtons ? `<div class="button-row compact">${undoButtons}</div>` : ""}
      </div>
    </article>
  `;
  }).join("");
  bindPlannedActions(list, items);
}

function closeAndResetPlannedForm() {
  renderPlannedForm();
  document.querySelector("#plannedForm").classList.add("hidden");
}

async function refreshPlannedArchive({ force = false } = {}) {
  if (!plannedArchiveState.expanded && !force) return plannedArchiveState.items;
  if (force) plannedArchiveState.stale = true;
  const pending = expandPlannedArchive(plannedArchiveState, {
    load: async () => {
      const data = await api(`/api/planned-expenses/archive?telegramUserId=${encodeURIComponent(telegramUserId)}`);
      return data.archivedPlannedExpenses ?? [];
    }
  });
  renderPlannedArchive();
  try {
    const items = await pending;
    renderPlannedArchive();
    return items;
  } catch (error) {
    renderPlannedArchive();
    throw error;
  }
}

async function refreshArchiveAfterDisable() {
  const shouldRefresh = invalidatePlannedArchive(plannedArchiveState);
  if (shouldRefresh) await refreshPlannedArchive({ force: true });
}

function renderPlannedArchive() {
  const toggle = document.querySelector("#plannedArchiveToggle");
  const content = document.querySelector("#plannedArchiveContent");
  const status = document.querySelector("#plannedArchiveStatus");
  const list = document.querySelector("#plannedArchiveList");
  if (!toggle || !content || !status || !list) return;

  toggle.setAttribute("aria-expanded", String(plannedArchiveState.expanded));
  content.classList.toggle("hidden", !plannedArchiveState.expanded);
  if (!plannedArchiveState.expanded) return;

  status.innerHTML = "";
  list.innerHTML = "";
  if (plannedArchiveState.status === "loading") {
    status.textContent = t("plan.archiveLoading");
    return;
  }
  if (plannedArchiveState.status === "error") {
    status.innerHTML = `${escapeHtml(t("plan.archiveError"))} <button type="button" class="ghost-button" data-retry-planned-archive>${escapeHtml(t("plan.archiveRetry"))}</button>`;
    status.querySelector("[data-retry-planned-archive]")?.addEventListener("click", async () => {
      try { await refreshPlannedArchive({ force: true }); } catch { /* keep retry state visible */ }
    });
    return;
  }
  if (plannedArchiveState.status !== "loaded") return;
  if (!plannedArchiveState.items.length) {
    status.textContent = t("plan.archiveEmpty");
    return;
  }

  const baseCurrency = dashboardState?.user?.base_currency ?? dashboardState?.snapshot?.baseCurrency ?? "THB";
  list.innerHTML = plannedArchiveState.items.map((item) => {
    const view = buildArchivedPlanView(item, { language: currentLanguage, translate: t });
    const disabledLabel = view.disabledAt
      ? formatDate(view.disabledAt, currentLanguage, userTimeZone())
      : view.disabledLabel;
    const paidAmounts = [moneyBase(view.paidAmountBase, baseCurrency)];
    const displayPaid = moneyDisplay(view.displayPaidAmount, item.display?.currency);
    if (displayPaid && item.display?.currency !== baseCurrency) paidAmounts.push(displayPaid);
    return `
      <article class="expense-row planned-archive__row" style="--category-color: ${categoryColor(item.category_slug)}">
        <div class="expense-main">
          <div class="expense-title">${escapeHtml(view.title)}</div>
          <div class="expense-meta">${escapeHtml(recurrenceLabel(item))} · ${escapeHtml(disabledLabel)}</div>
          <div class="expense-meta">${escapeHtml(view.paymentLabel)} · ${escapeHtml(paidAmounts.join(" · "))}</div>
        </div>
        <div class="expense-actions">
          <div class="expense-amount">${formatMoney(item.amount, item.currency)}
            <em>${moneyDisplay(item.display?.amount, item.display?.currency)}</em>
          </div>
          <div class="button-row compact">
            <button type="button" class="ghost-button" data-recreate-planned="${escapeAttribute(item.id)}">${t("plan.createAgain")}</button>
          </div>
        </div>
      </article>
    `;
  }).join("");
  list.querySelectorAll("[data-recreate-planned]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = plannedArchiveState.items.find((planned) => String(planned.id) === button.dataset.recreatePlanned);
      if (!item) return;
      renderPlannedForm(item, { mode: "recreate", sourcePlannedExpenseId: item.id });
      const form = document.querySelector("#plannedForm");
      form.classList.remove("hidden");
      form.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function plannedPaymentProgressLabel(item) {
  const occurrences = buildPlannedOccurrences(item);
  if (!occurrences.length) return "";
  const paid = occurrences.filter((occurrence) => occurrence.paid).length;
  if (occurrences.length === 1) {
    return paid ? t("plan.paidSuffix") : (currentLanguage === "ru" ? "не оплачено" : "unpaid");
  }
  return `${paid}/${occurrences.length} ${currentLanguage === "ru" ? "оплачено" : "paid"}`;
}

function bindPlannedActions(container, items) {
  container.querySelectorAll("[data-edit-planned]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = items.find((planned) => String(planned.id) === button.dataset.editPlanned);
      switchTab("plan");
      renderPlannedForm(item, { mode: "edit" });
      document.querySelector("#plannedForm").classList.remove("hidden");
      document.querySelector("#plannedForm").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  container.querySelectorAll("[data-delete-planned]").forEach((button) => {
    button.addEventListener("click", async () => {
      const item = items.find((planned) => String(planned.id) === button.dataset.deletePlanned);
      if (!item) return;
      try {
        await runPlannedDisable({
          button,
          item,
          confirm: window.confirm.bind(window),
          disableRequest: (id) => api(`/api/planned-expenses/${id}`, {
            method: "DELETE",
            body: { telegramUserId }
          }),
          loadDashboard,
          afterDashboard: refreshArchiveAfterDisable,
          showResult: showToast,
          language: currentLanguage,
          createTranslator,
          translate: t,
          formatMoney
        });
      } catch (error) {
        showError(error);
      }
    });
  });
  container.querySelectorAll("[data-pay-planned]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      const originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = currentLanguage === "ru" ? "Оплачиваю…" : "Paying…";
      try {
        const body = { telegramUserId };
        if (button.dataset.occurrenceDate) body.occurrenceDate = button.dataset.occurrenceDate;
        await api(`/api/planned-expenses/${button.dataset.payPlanned}/pay`, { method: "POST", body });
        await loadDashboard();
        await loadHistory();
        showToast(t("toast.paymentSaved"));
      } catch (error) {
        button.disabled = false;
        button.textContent = originalLabel;
        const code = String(error.message || "");
        const message = code === "planned_expense_already_paid"
          ? t("toast.plannedAlreadyPaid")
          : code === "planned_expense_not_found"
            ? t("toast.plannedNotFound")
            : code === "invalid_occurrence"
              ? t("toast.plannedInvalidOccurrence")
              : code === "future_occurrence"
                ? t("toast.plannedFutureOccurrence")
                : code === "internal_error" || !code
                  ? t("toast.paymentFailed")
                  : code;
        showToast(message);
      }
    });
  });
  container.querySelectorAll("[data-undo-planned]").forEach((button) => {
    button.addEventListener("click", async () => {
      const item = items.find((planned) => String(planned.id) === button.dataset.undoPlanned);
      if (!item) return;
      await runPlannedPaymentUndo({
        button,
        item,
        occurrenceDate: button.dataset.occurrenceDate,
        confirm: window.confirm.bind(window),
        undoRequest: (id, occurrenceDate) => api(`/api/planned-expenses/${id}/payments/${encodeURIComponent(occurrenceDate)}`, {
          method: "DELETE",
          body: { telegramUserId }
        }),
        loadDashboard,
        loadHistory,
        showToast,
        showError: showToast,
        translate: t,
        formatOccurrenceDate: (value) => formatDateOnly(`${value}T12:00:00.000Z`, currentLanguage, "UTC")
      });
    });
  });
  container.querySelectorAll("[data-planned-menu]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const item = items.find((planned) => String(planned.id) === button.dataset.plannedMenu);
      if (!item) return;
      const popover = document.querySelector("#plannedDuePopover");
      if (popover && !popover.classList.contains("hidden") && popover.dataset.plannedId === String(item.id)) {
        popover.classList.add("hidden");
        return;
      }
      openPlannedDueMenu(item, button);
    });
  });
  const popover = container.querySelector("#plannedDuePopover");
  if (popover) {
    popover.querySelectorAll("[data-edit-planned]").forEach((button) => {
      button.addEventListener("click", () => {
        const item = items.find((planned) => String(planned.id) === button.dataset.editPlanned);
        popover.classList.add("hidden");
        switchTab("plan");
        renderPlannedForm(item, { mode: "edit" });
        document.querySelector("#plannedForm").classList.remove("hidden");
        document.querySelector("#plannedForm").scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    popover.querySelectorAll("[data-open-plan-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        popover.classList.add("hidden");
        switchTab("plan");
      });
    });
  }
}

function renderDraftEditor(draft) {
  const section = document.querySelector("#draftEditorSection");
  const title = document.querySelector("#draftEditorTitle");
  const form = document.querySelector("#draftForm");
  if (title) title.textContent = draft.status === "inbox" ? (currentLanguage === "ru" ? "Разобрать черновик" : "Review draft") : (currentLanguage === "ru" ? "Черновик" : "Draft");
  section.classList.remove("hidden");
  form.innerHTML = `
    <div class="form-stack">
      ${draft.items.map((item, index) => editableItemFields(item, `draft-${index}`, index)).join("")}
      <div class="button-row">
        <button type="submit">${t("actions.saveChanges")}</button>
        <button type="button" id="confirmDraftButton">${t("actions.confirm")}</button>
        <button type="button" class="danger-button" id="cancelDraftButton">${t("actions.cancelDraft")}</button>
        <button type="button" class="ghost-button" id="closeDraftButton">${t("actions.close")}</button>
      </div>
    </div>
  `;
  form.onsubmit = saveDraft;
  form.querySelector("#confirmDraftButton").addEventListener("click", confirmDraft);
  form.querySelector("#cancelDraftButton").addEventListener("click", cancelDraftFromEditor);
  form.querySelector("#closeDraftButton").addEventListener("click", closeDraftEditor);
  form.addEventListener("input", () => { draftDirty = true; });
  draftDirty = false;
}

function renderExpenseEditor(expense, options = {}) {
  if (!expense) return;
  expenseReturnTab = options.returnTab ?? "dashboard";
  switchTab("dashboard");
  const section = document.querySelector("#expenseEditorSection");
  const title = document.querySelector("#expenseEditorTitle");
  const form = document.querySelector("#expenseForm");
  if (title) title.textContent = currentLanguage === "ru" ? `Расход: ${expense.description}` : `Expense: ${expense.description}`;
  section.classList.remove("hidden");
  form.innerHTML = `
    <div class="form-stack">
      ${editableItemFields({
        amount: expense.amount_original,
        currency: expense.currency_original,
        description: expense.description,
        category_slug: expense.category_slug,
        budget_impact: expense.budget_impact ?? "regular",
        tags: expense.tags ?? [],
        spent_at: expense.spent_at
      }, "expense", 0)}
      <div class="button-row">
        <button type="submit">${currentLanguage === "ru" ? "Сохранить расход" : "Save expense"}</button>
        <button type="button" class="ghost-button" id="closeExpenseEditorButton">${t("actions.close")}</button>
      </div>
    </div>
  `;
  form.onsubmit = (event) => saveExpense(event, expense.id);
  form.querySelector("#closeExpenseEditorButton").addEventListener("click", closeExpenseEditor);
  section.scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeDraftEditor() {
  if (draftDirty && !window.confirm(t("confirmations.closeWithoutSaving"))) return;
  document.querySelector("#draftEditorSection").classList.add("hidden");
  draftState = null;
  draftDirty = false;
  switchTab(draftReturnTab);
}

function closeExpenseEditor() {
  document.querySelector("#expenseEditorSection").classList.add("hidden");
  switchTab(expenseReturnTab);
}

function editableItemFields(item, prefix, index) {
  return `
    <fieldset class="edit-card" data-index="${index}">
      <label>
        <span>${t("forms.description")}</span>
        <input name="${prefix}-description" value="${escapeAttribute(item.description ?? "")}" required />
      </label>
      <div class="field-grid">
        <label>
          <span>${t("forms.amount")}</span>
          <input name="${prefix}-amount" type="number" min="0.01" step="0.01" value="${Number(item.amount)}" required />
        </label>
        <label>
          <span>${t("forms.currency")}</span>
          <select name="${prefix}-currency">${currencyOptions(item.currency, option)}</select>
        </label>
      </div>
      <label>
        <span>${t("forms.category")}</span>
        <select name="${prefix}-category_slug">${categories.map(([slug]) => option(slug, item.category_slug, categoryLabel(slug, currentLanguage))).join("")}</select>
      </label>
      <label>
        <span>${currentLanguage === "ru" ? "Тип расхода" : "Expense type"}</span>
        <select name="${prefix}-budget_impact">
          ${option("regular", item.budget_impact ?? "regular", currentLanguage === "ru" ? "Обычная" : "Regular")}
          ${option("planned", item.budget_impact ?? "regular", currentLanguage === "ru" ? "Плановая" : "Planned")}
          ${option("large_oneoff", item.budget_impact ?? "regular", currentLanguage === "ru" ? "Крупная" : "Large")}
        </select>
      </label>
      <label>
        <span>${t("forms.dateAndTime")}</span>
        <input name="${prefix}-spent_at" type="datetime-local" value="${dateTimeLocal(item.spent_at, dashboardState?.user?.timezone)}" required />
      </label>
      <label>
        <span>${t("forms.tagsComma")}</span>
        <input name="${prefix}-tags" value="${escapeAttribute((item.tags ?? []).join(", "))}" />
      </label>
    </fieldset>
  `;
}

async function saveSettings(event) {
  event.preventDefault();
  if (accountDeleted) return;
  await api("/api/settings", {
    method: "PATCH",
    body: {
      telegramUserId,
      settings: {
        monthlyBudgetAmount: Number(document.querySelector("#budgetInput").value),
        weeklyBudgetAmount: document.querySelector("#weeklyBudgetInput").value.trim(),
        baseCurrency: document.querySelector("#baseCurrencyInput").value,
        displayCurrency: document.querySelector("#displayCurrencyInput").value,
        interfaceLanguage: document.querySelector("#interfaceLanguageInput").value,
        interfaceTheme: document.querySelector("#interfaceThemeInput").value,
        timezone: document.querySelector("#timezoneInput").value,
        dailyEntryReminderEnabled: document.querySelector("#dailyReminderInput").checked,
        usdThbRate: Number(document.querySelector("#usdThbRateInput").value)
      }
    }
  });
  await loadDashboard();
  setSettingsDirtyBaseline();
  showToast(t("toast.settingsSaved"));
}

async function requestExpenseExport(period) {
  if (accountDeleted) return;
  try {
    const result = await api("/api/exports/expenses", {
      method: "POST",
      body: { period }
    });
    showToast(result.message ?? t("toast.exportRequested"));
  } catch (error) {
    showToast(error.body?.message ?? error.message);
  }
}

async function callAccountDeletion(endpoint, body = {}) {
  return api(endpoint, {
    method: "POST",
    body: { source: "miniapp", ...body }
  });
}

function setDeleteAccountStage(stage) {
  document.getElementById("deleteAccountStartState")?.classList.toggle("hidden", stage !== "start");
  document.getElementById("deleteAccountWarningState")?.classList.toggle("hidden", stage !== "warning");
  document.getElementById("deleteAccountConfirmState")?.classList.toggle("hidden", stage !== "confirm");
  deleteAccountCancelButton?.classList.toggle("hidden", stage === "start");
  if (stage !== "confirm" && deleteAccountConfirmInput && deleteAccountConfirmButton) {
    deleteAccountConfirmInput.value = "";
    deleteAccountConfirmButton.disabled = true;
  }
}

function showAccountDeletionError(error) {
  const code = error.body?.error ?? error.message;
  if (code === "account_deletion_expired") {
    setDeleteAccountStage("start");
    showToast(t("toast.accountDeletionExpired"));
    return;
  }
  showToast(t("toast.accountDeletionFailed"));
}

async function requestAccountDeletion() {
  if (accountDeleted) return;
  try {
    await callAccountDeletion("/api/account-deletion/request");
    setDeleteAccountStage("warning");
    showToast(t("toast.accountDeletionRequested"));
  } catch (error) {
    showAccountDeletionError(error);
  }
}

async function advanceAccountDeletion() {
  if (accountDeleted) return;
  try {
    await callAccountDeletion("/api/account-deletion/advance");
    setDeleteAccountStage("confirm");
    deleteAccountConfirmInput?.focus();
  } catch (error) {
    showAccountDeletionError(error);
  }
}

async function cancelAccountDeletion() {
  if (accountDeleted) return;
  try {
    await callAccountDeletion("/api/account-deletion/cancel");
    setDeleteAccountStage("start");
    showToast(t("toast.accountDeletionCancelled"));
  } catch (error) {
    showAccountDeletionError(error);
  }
}

async function confirmAccountDeletion() {
  if (accountDeleted) return;
  const confirmationText = deleteAccountConfirmInput?.value ?? "";
  if (confirmationText !== "DELETE") return;
  try {
    await callAccountDeletion("/api/account-deletion/confirm", { confirmationText });
    renderDeletedState();
  } catch (error) {
    showAccountDeletionError(error);
  }
}

function renderDeletedState() {
  accountDeleted = true;
  const bottomTabs = document.querySelector(".bottom-tabs");
  bottomTabs?.querySelectorAll("button").forEach((button) => {
    button.disabled = true;
  });
  bottomTabs?.classList.add("hidden");
  bottomTabs?.setAttribute("aria-hidden", "true");
  document.querySelectorAll("#settingsForm input, #settingsForm select, #settingsForm button").forEach((control) => {
    control.disabled = true;
  });
  document.querySelectorAll("[data-export-period]").forEach((control) => {
    control.disabled = true;
  });
  document.querySelectorAll("#dashboardTab button, #planTab button, #historyTab button, #dashboardTab input, #planTab input, #historyTab input, #dashboardTab select, #planTab select, #historyTab select").forEach((control) => {
    control.disabled = true;
  });

  const section = document.getElementById("deleteAccountSection");
  if (!section) return;
  const title = document.createElement("h3");
  title.className = "settings-section-title danger-zone__label";
  title.textContent = t("settings.deleteDataDeletedTitle");
  const body = document.createElement("p");
  body.className = "deleted-account-state";
  body.textContent = t("settings.deleteDataDeletedBody");
  section.classList.add("danger-zone--deleted");
  section.replaceChildren(title, body);
}

function detectTimezone() {
  const input = document.querySelector("#timezoneInput");
  if (!input) return;
  input.value = detectBrowserTimeZone();
  updateSettingsDirtyState();
}

function renderTimezoneOptions(value) {
  const input = document.querySelector("#timezoneInput");
  if (!input) return;
  const selected = normalizeSettingsTimeZone(value);
  input.innerHTML = COMMON_TIMEZONES
    .map((timeZone) => option(timeZone, selected, timeZone))
    .join("");
  input.value = selected;
}

async function saveCurrentMonthBudget() {
  await api("/api/settings/current-month-budget", {
    method: "PATCH",
    body: {
      telegramUserId,
      currentMonthBudgetAmount: Number(document.querySelector("#currentMonthBudgetInput").value),
      currency: dashboardState?.user?.base_currency ?? dashboardState?.snapshot?.baseCurrency ?? "THB"
    }
  });
  await loadDashboard();
  setSettingsDirtyBaseline();
  showToast(t("toast.settingsSaved"));
}

async function saveReserve(event) {
  event.preventDefault();
  const recurring = document.querySelector("#reserveRecurringInput").checked;
  const scope = recurring ? document.querySelector("#reserveScopeInput").value : "current";
  try {
    await api("/api/reserve/current", {
      method: "PUT",
      body: {
        telegramUserId,
        reserve: {
          amount: Number(document.querySelector("#reserveAmountInput").value),
          title: document.querySelector("#reserveTitleInput").value,
          scope
        }
      }
    });
    await loadDashboard();
    reserveSettingsExpanded = false;
    renderReserveSettings();
    showToast(t("reserve.savedAction"));
  } catch (error) {
    showToast(error.message === "reserve_exceeds_free_budget" ? t("reserve.validationError") : error.message);
  }
}

async function disableReserve() {
  const recurring = document.querySelector("#reserveRecurringInput").checked;
  const scope = recurring ? document.querySelector("#reserveScopeInput").value : "current";
  await api("/api/reserve/current/disable", {
    method: "POST",
    body: { telegramUserId, scope }
  });
  await loadDashboard();
  reserveSettingsExpanded = false;
  renderReserveSettings();
  showToast(t("reserve.disabledAction"));
}

async function renderClosedReserveEvents(events) {
  if (!events.length) return;
  const latest = events.at(-1);
  const amount = latest.saved_amount > 0 ? latest.saved_amount : latest.reserve_amount;
  showToast(latest.status === "saved"
    ? t("reserve.closedSaved", { amount: moneyBase(amount) })
    : t("reserve.closedUsed", { amount: moneyBase(amount) }));
  await api("/api/reserve-events/ack", {
    method: "POST",
    body: { telegramUserId, eventIds: events.map((event) => event.id) }
  });
}

async function saveDraft(event) {
  event.preventDefault();
  await saveDraftItems({ showFeedback: true });
}

async function saveDraftItems(options = {}) {
  const items = draftState.items.map((item, index) => collectItem(`draft-${index}`, item));
  let status = 200;
  let errorBody = null;
  let data;
  try {
    data = await api(`/api/drafts/${draftState.id}`, { method: "PATCH", body: { telegramUserId, items, expectedVersion: draftState.version } });
  } catch (error) {
    status = error?.status ?? 500;
    errorBody = error?.body ?? null;
    const outcome = resolveDraftSaveResponse(status, errorBody);
    if (outcome.conflict) {
      draftState = outcome.draft;
      renderDraftEditor(draftState);
      draftDirty = false;
      showToast(t("toast.draftConflict"));
      return { saved: false };
    }
    throw error;
  }
  draftState = data.draft;
  renderDraftEditor(draftState);
  draftDirty = false;
  if (options.showFeedback) showToast(t("toast.draftSaved"));
  return { saved: true };
}

async function confirmDraft() {
  const saveResult = await saveDraftItems();
  if (!saveResult?.saved) return;
  const data = await api(`/api/drafts/${draftState.id}/confirm`, { method: "POST", body: { telegramUserId, language: currentLanguage } });
  const outcome = classifyConfirmOutcome(data);
  document.querySelector("#draftEditorSection").classList.add("hidden");
  await loadDashboard();
  await loadHistory();
  showToast(outcome.alreadySaved ? t("toast.alreadySaved") : t("toast.draftConfirmed"));
  switchTab(draftReturnTab);
}

async function cancelDraftFromEditor() {
  if (!window.confirm(t("confirmations.closeWithoutSaving"))) return;
  await api(`/api/drafts/${draftState.id}`, { method: "DELETE", body: { telegramUserId, language: currentLanguage } });
  document.querySelector("#draftEditorSection").classList.add("hidden");
  draftState = null;
  draftDirty = false;
  await loadDashboard();
  await loadHistory();
  showToast(t("toast.draftCanceled"));
}

async function saveExpense(event, expenseId) {
  event.preventDefault();
  await api(`/api/expenses/${expenseId}`, { method: "PATCH", body: { telegramUserId, expense: collectItem("expense", {}) } });
  document.querySelector("#expenseEditorSection").classList.add("hidden");
  await loadDashboard();
  await loadHistory();
  showToast(t("toast.expenseSaved"));
  switchTab(expenseReturnTab);
}

async function savePlanned(event, {
  mode = "create",
  plannedId = null,
  sourcePlannedExpenseId = null,
  recreateSession = null
} = {}) {
  event.preventDefault();
  if (mode === "recreate") {
    const form = event.currentTarget;
    const submitButton = form.querySelector('button[type="submit"]');
    try {
      await runPlannedRecreate({
        session: recreateSession,
        recreateRequest: async () => {
          submitButton.disabled = true;
          try {
            return await api(`/api/planned-expenses/${sourcePlannedExpenseId}/recreate`, {
              method: "POST",
              body: {
                telegramUserId,
                startsOn: input("planned-starts_on").value,
                plannedExpense: collectPlanned()
              }
            });
          } catch (error) {
            submitButton.disabled = false;
            throw error;
          }
        },
        closeForm: closeAndResetPlannedForm,
        loadDashboard,
        refreshArchive: () => refreshPlannedArchive({ force: true }),
        showCreated: () => showToast(t("toast.plannedRecreated")),
        showRefreshWarning: () => showToast(t("toast.plannedRefreshWarning"))
      });
    } catch (error) {
      if (error.message === "reserve_conflicts_with_planned_change") {
        showToast(t("reserve.plannedChangeError"));
        return;
      }
      showError(error);
    }
    return;
  }

  const method = plannedId ? "PATCH" : "POST";
  const path = plannedId ? `/api/planned-expenses/${plannedId}` : "/api/planned-expenses";
  try {
    await api(path, { method, body: { telegramUserId, plannedExpense: collectPlanned() } });
  } catch (error) {
    if (error.message === "reserve_conflicts_with_planned_change") {
      showToast(t("reserve.plannedChangeError"));
      return;
    }
    throw error;
  }
  closeAndResetPlannedForm();
  await loadDashboard();
  showToast(plannedId ? t("toast.plannedSaved") : t("toast.plannedAdded"));
}

function collectItem(prefix, original) {
  return {
    amount: Number(input(`${prefix}-amount`).value),
    currency: input(`${prefix}-currency`).value,
    description: input(`${prefix}-description`).value.trim(),
    category_slug: input(`${prefix}-category_slug`).value,
    budget_impact: input(`${prefix}-budget_impact`)?.value ?? original.budget_impact ?? "regular",
    category_source: "user",
    spent_at: new Date(input(`${prefix}-spent_at`).value).toISOString(),
    tags: input(`${prefix}-tags`).value.split(",").map((tag) => tag.trim()).filter(Boolean),
    confidence: original.confidence ?? 1,
    needs_review: false
  };
}

function collectPlanned() {
  const recurrence = input("planned-recurrence").value;
  const dueDays = parseDueDays(input("planned-due_days")?.value);
  const monthlyDay = input("planned-due_day")?.value ? Number(input("planned-due_day").value) : null;
  return {
    amount: Number(input("planned-amount").value),
    currency: input("planned-currency").value,
    description: input("planned-description").value.trim(),
    category_slug: input("planned-category_slug").value,
    recurrence,
    due_day: recurrence === "monthly" ? monthlyDay : null,
    due_days: recurrence === "twice_monthly" ? dueDays : (monthlyDay ? [monthlyDay] : []),
    weekday: recurrence === "weekly" ? Number(input("planned-weekday").value) : null,
    due_date: recurrence === "one_off" ? input("planned-due_date").value : null,
    tags: input("planned-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean),
    active: true
  };
}

function input(name) {
  return document.querySelector(`[name="${name}"]`);
}

function collectSettingsState() {
  return JSON.stringify({
    monthlyBudgetAmount: document.querySelector("#budgetInput")?.value ?? "",
    weeklyBudgetAmount: document.querySelector("#weeklyBudgetInput")?.value ?? "",
    baseCurrency: document.querySelector("#baseCurrencyInput")?.value ?? "",
    displayCurrency: document.querySelector("#displayCurrencyInput")?.value ?? "",
    dailyEntryReminderEnabled: document.querySelector("#dailyReminderInput")?.checked === true,
    interfaceLanguage: document.querySelector("#interfaceLanguageInput")?.value ?? "",
    interfaceTheme: document.querySelector("#interfaceThemeInput")?.value ?? "",
    timezone: document.querySelector("#timezoneInput")?.value ?? "",
    usdThbRate: document.querySelector("#usdThbRateInput")?.value ?? ""
  });
}

function setSettingsDirtyBaseline() {
  settingsBaseline = collectSettingsState();
  updateSettingsDirtyState();
}

function updateSettingsDirtyState() {
  const status = document.querySelector("#settingsDirtyState");
  if (!status) return;
  const dirty = settingsBaseline !== "" && collectSettingsState() !== settingsBaseline;
  status.textContent = dirty ? t("settings.unsavedChanges") : t("settings.saveHint");
  status.dataset.state = dirty ? "dirty" : "clean";
}

function updateSettingsDecorations() {
  updateCurrencyMark("#baseCurrencyMark", "#baseCurrencyInput");
  updateCurrencyMark("#displayCurrencyMark", "#displayCurrencyInput");
}

function updateCurrencyMark(markSelector, inputSelector) {
  const mark = document.querySelector(markSelector);
  const select = document.querySelector(inputSelector);
  if (!mark || !select) return;
  mark.innerHTML = currencyMarkHtml(select.value);
}

function currencyMarkHtml(currency) {
  const normalized = String(currency ?? "").toUpperCase();
  const svg = CURRENCY_MARKS[normalized];
  if (svg) return svg;
  return `<span class="currency-code-fallback">${escapeHtml(normalized || "???")}</span>`;
}

function option(value, selected, label = value) {
  return `<option value="${value}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function applyLanguage(language) {
  currentLanguage = language === "ru" ? "ru" : "en";
  translate = createTranslator(currentLanguage);
  document.documentElement.lang = currentLanguage;
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    element.setAttribute("placeholder", t(element.dataset.i18nPlaceholder));
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  });
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const label = button.querySelector(".tab-button__label");
    if (label) label.textContent = t(`screen.${button.dataset.tab}`);
    else button.textContent = t(`screen.${button.dataset.tab}`);
  });
  setOptionalText("#settingsTab h2", t("settings.title"));
  const labels = [
    ["#budgetInput", "settings.monthlyBudget"],
    ["#currentMonthBudgetInput", "settings.currentMonthBudget"],
    ["#weeklyBudgetInput", "settings.weeklyBudget"],
    ["#baseCurrencyInput", "settings.baseCurrency"],
    ["#displayCurrencyInput", "settings.displayCurrency"],
    ["#interfaceLanguageInput", "settings.interfaceLanguage"],
    ["#interfaceThemeInput", "settings.interfaceTheme"],
    ["#timezoneInput", "settings.timezone"]
  ];
  for (const [selector, key] of labels) {
    const label = document.querySelector(selector)?.closest("label")?.querySelector("span");
    if (label) label.textContent = t(key);
  }
  const save = document.querySelector("#settingsForm button[type='submit']");
  if (save) save.textContent = t("actions.save");
  updateSettingsDirtyState();
  updateSettingsDecorations();
  renderReserveSettings();
  updateHistoryFilterChips();
  if (historyCalendarDraft) renderHistoryCalendar();
  renderPlannedArchive();
}

function applyTheme(theme) {
  currentTheme = theme === "dark" ? "dark" : "light";
  document.body.dataset.theme = currentTheme;
}

function t(key, values = {}) {
  return translate(key, values);
}

function setOptionalText(selector, text) {
  if (text == null) return;
  const element = document.querySelector(selector);
  if (element) element.textContent = text;
}

function recurrenceLabel(item) {
  return plannedRecurrenceLabel(item, (value) => formatDate(value, currentLanguage, userTimeZone()), currentLanguage);
}

function userTimeZone(user = dashboardState?.user) {
  return normalizeSettingsTimeZone(user?.timezone);
}

function weekdayOptions(selected) {
  return plannedWeekdayOptions(selected, option, currentLanguage);
}
function setText(selector, text) {
  document.querySelector(selector).textContent = text;
}

function setHtml(selector, html) {
  document.querySelector(selector).innerHTML = html;
}

function showError(error) {
  document.querySelector("#latestExpenses").innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  showToast(error.message);
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.classList.add("hidden");
  }, 2200);
}


