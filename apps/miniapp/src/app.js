import { createApiClient } from "./apiClient.js";
import { categories, categoryColor, categoryLabel } from "./categories.js";
import { currencyOptions } from "./currencies.js";
import { buildDashboardCards, renderDashboardCards } from "./dashboardCards.js";
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
  setBaseCurrency
} from "./formatters.js";
import { groupByDay } from "./history.js";
import { createTranslator } from "./i18n.js";
import { inboxDraftDescription, inboxDraftTotal, shouldShowInboxOnDashboard, updateFirstInboxItemCategory } from "./inbox.js";
import {
  calculatePlannedMonthSummary,
  defaultPlannedCurrency,
  isDueToday,
  isPlannedPaid,
  nextUnpaidPlannedItem,
  parseDueDays,
  recurrenceLabel as plannedRecurrenceLabel,
  weekdayOptions as plannedWeekdayOptions
} from "./planned.js";

const params = new URLSearchParams(window.location.search);
const telegramUserId = params.get("telegramUserId") || window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
const draftId = params.get("draftId");

const percentNumber = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const api = createApiClient();
let dashboardState = null;
let draftState = null;
let draftReturnTab = "dashboard";
let expenseReturnTab = "dashboard";
let historyState = [];
let inboxState = [];
let hiddenNoticeIds = new Set();
let currentLanguage = "en";
let translate = createTranslator(currentLanguage);
let currentTheme = "light";

if (window.Telegram?.WebApp) {
  window.Telegram.WebApp.ready();
  window.Telegram.WebApp.expand();
}

document.querySelector("#settingsForm").addEventListener("submit", saveSettings);
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
document.querySelectorAll("[data-tab]").forEach((button) => {
  button.addEventListener("click", () => switchTab(button.dataset.tab));
});
document.querySelector("#baseCurrencyInput").addEventListener("change", updateCurrencyFlags);
document.querySelector("#displayCurrencyInput").addEventListener("change", updateCurrencyFlags);
document.querySelector("#interfaceLanguageInput").addEventListener("change", updateCurrencyFlags);
document.querySelector("#openHistoryInboxButton")?.addEventListener("click", () => switchTab("history"));

applyLanguage(currentLanguage);
load().catch(showError);

async function load() {
  if (!telegramUserId) throw new Error("No Telegram user id. Open Mini App from the bot.");
  renderPlannedForm();
  await loadDashboard();
  await loadHistory();
  if (draftId) await openDraftInline(draftId, {
    returnTab: "dashboard",
    row: document.querySelector(`[data-inbox-location="dashboard"][data-draft-row="${draftId}"]`)
      ?? document.querySelector(`[data-draft-row="${draftId}"]`)
  });
}

async function loadDashboard() {
  const data = await api(`/api/dashboard?telegramUserId=${encodeURIComponent(telegramUserId)}`);
  dashboardState = data;
  setBaseCurrency(data.user?.base_currency ?? data.snapshot?.baseCurrency ?? "THB");
  renderSettings(data.user);
  renderPlannedForm();
  renderSnapshot(data.snapshot);
  renderPlannedNotice(data.plannedExpenses ?? []);
  renderNextPlannedSummary(data.plannedExpenses ?? []);
  renderAnalytics(data.snapshot, data.analytics ?? {});
  renderTopCategories(data.topCategories ?? [], data.snapshot.month);
  renderPlannedMonthSummary(data.plannedExpenses ?? []);
  renderPlannedExpenses(data.plannedExpenses ?? []);
  renderLatest(data.latestExpenses ?? []);
}

function renderAnalytics(snapshot, analytics) {
  renderRecoveryAdvice(snapshot);
  setText("#forecastMonth", moneyBase(snapshot.forecastMonthTotal));
  setText("#forecastMonthDisplay", moneyDisplay(snapshot.display?.forecastMonthTotal, snapshot.display?.currency));

  const deviation = Number(snapshot.planDeviation ?? 0);
  const deviationRow = document.querySelector("#planDeviation").closest(".plan-row");
  deviationRow.classList.toggle("good", deviation < 0);
  deviationRow.classList.toggle("bad", deviation > 0);
  deviationRow.classList.toggle("neutral", deviation === 0);
  setText("#planDeviationLabel", deviation > 0 ? t("dashboard.overPlan") : deviation < 0 ? t("dashboard.underPlan") : t("dashboard.onPlan"));
  setText("#planDeviation", deviation === 0 ? moneyBase(0) : `${currentLanguage === "ru" ? "на " : ""}${moneyBase(Math.abs(deviation))}`);
  setText("#planDeviationDisplay", moneyDisplay(Math.abs(snapshot.display?.planDeviation ?? 0), snapshot.display?.currency));

  setText("#todayLimit", `${moneyBase(snapshot.today)} / ${moneyBase(snapshot.dailyPlanLimit)}`);
  setText("#todayLimitDisplay", `${moneyDisplay(snapshot.display?.today, snapshot.display?.currency)} / ${moneyDisplay(snapshot.display?.dailyPlanLimit, snapshot.display?.currency)}`);

  const comparison = analytics.weekComparison ?? {};
  const weekPrefix = Number(comparison.delta) > 0 ? "+" : "";
  setText("#weekComparison", `${weekPrefix}${moneyBase(comparison.delta ?? 0)}`);
  setText("#weekComparisonDisplay", moneyDisplaySigned(comparison.display?.delta, comparison.display?.currency));

  renderOtherWarning(analytics.otherCategoryWarning);
  renderLargestExpenses(analytics);
  renderTopTags(analytics.topTags ?? []);
  renderHeatmap(analytics.dailyHeatmap ?? [], snapshot.daysInMonth ?? 30);
}

function renderOtherWarning(warning) {
  const notice = document.querySelector("#otherWarning");
  if (!warning?.active) {
    notice.classList.add("hidden");
    notice.innerHTML = "";
    return;
  }
  notice.classList.remove("hidden");
  notice.innerHTML = `
    <div class="notice-title">
      <span>${currentLanguage === "ru" ? `Категория “Другое” уже ${warning.percent}% месяца` : `Other is already ${warning.percent}% of the month`}</span>
      <strong>${moneyBase(warning.total)}</strong>
    </div>
    <div class="expense-meta">${currentLanguage === "ru" ? "Стоит разобрать эти траты, чтобы статистика была полезнее." : "Review these expenses to make the stats more useful."}</div>
  `;
}

function renderNextPlannedSummary(items) {
  const block = document.querySelector("#nextPlannedSummary");
  const next = nextUnpaidPlannedItem(items);
  if (!next) {
    block.classList.add("hidden");
    block.innerHTML = "";
    return;
  }
  block.classList.remove("hidden");
  block.innerHTML = `
    <div>
      <span>${t("plan.nextPlanned")}</span>
      <strong>${escapeHtml(next.item.description)}</strong>
      <em>${formatDateOnly(next.date, currentLanguage)} · ${moneyBase(next.item.amount_base ?? next.item.amount)}</em>
    </div>
    <button type="button" class="ghost-button" data-open-plan>Plan</button>
  `;
  block.querySelector("[data-open-plan]").addEventListener("click", () => switchTab("plan"));
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
        <div class="expense-meta">${formatDate(expense.spent_at, currentLanguage)} · ${escapeHtml(categoryLabel(expense.category_slug, currentLanguage))}</div>
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

function renderRecoveryAdvice(snapshot) {
  const advice = snapshot.recoveryAdvice;
  const recovery = document.querySelector("#recoveryAdvice");
  const planSummary = document.querySelector(".plan-summary");
  if (!advice?.active) {
    recovery.classList.add("hidden");
    planSummary.classList.remove("hidden");
    return;
  }
  planSummary.classList.add("hidden");
  recovery.classList.remove("hidden");
  recovery.dataset.state = advice.state;
  setText("#recoveryBadge", advice.state === "danger" ? t("budgetAdvice.dangerBadge") : t("budgetAdvice.warnBadge"));
  setText("#recoveryRequiredPerDay", `${moneyBase(advice.requiredPerDay)}/${t("dashboard.day")}`);
  setText("#recoveryRequiredPerDayDisplay", `${moneyDisplay(advice.display?.requiredPerDay, advice.display?.currency)}/${t("dashboard.day")}`);
  setText("#recoveryMicroAdvice", advice.state === "danger" ? t("budgetAdvice.dangerText", { amount: moneyBase(advice.requiredPerDay) }) : t("budgetAdvice.warnText", { amount: moneyBase(advice.requiredPerDay) }));
  setText("#recoveryMonthNow", `${moneyBase(snapshot.month)} / ${moneyBase(snapshot.monthlyBudget)}`);
  setText("#recoveryMonthNowDisplay", `${moneyDisplay(snapshot.display?.month, snapshot.display?.currency)} / ${moneyDisplay(snapshot.display?.monthlyBudget, snapshot.display?.currency)}`);
  setText("#recoveryForecast", moneyBase(snapshot.forecastMonthTotal));
  setText("#recoveryForecastDisplay", moneyDisplay(snapshot.display?.forecastMonthTotal, snapshot.display?.currency));
  setText("#recoveryOverBudget", `${currentLanguage === "ru" ? "на " : ""}${moneyBase(advice.forecastOverBudget)}`);
  setText("#recoveryOverBudgetDisplay", moneyDisplay(advice.display?.forecastOverBudget, advice.display?.currency));
  setText("#recoveryToday", `${moneyBase(snapshot.today)} / ${moneyBase(snapshot.dayPlanLimit ?? snapshot.dailyPlanLimit ?? 0)}`);
  setText("#recoveryTodayDisplay", `${moneyDisplay(snapshot.display?.today, snapshot.display?.currency)} / ${moneyDisplay(snapshot.display?.dayPlanLimit, snapshot.display?.currency)}`);
}

async function loadHistory() {
  const search = document.querySelector("#historySearch").value.trim();
  const [data, inbox] = await Promise.all([
    api(`/api/expenses?telegramUserId=${encodeURIComponent(telegramUserId)}&period=month&search=${encodeURIComponent(search)}`),
    api(`/api/drafts?telegramUserId=${encodeURIComponent(telegramUserId)}&status=inbox`)
  ]);
  historyState = data.expenses ?? [];
  inboxState = inbox.drafts ?? [];
  renderDashboardInboxDrafts(inboxState);
  renderInboxDrafts(inboxState);
  renderHistory(historyState);
}

async function loadDraft(id, options = {}) {
  const data = await api(`/api/drafts/${id}?telegramUserId=${encodeURIComponent(telegramUserId)}`);
  draftState = data.draft;
  draftReturnTab = options.returnTab ?? "dashboard";
  renderDraftEditor(draftState);
}

function switchTab(tab) {
  document.querySelector("#dashboardTab").classList.toggle("hidden", tab !== "dashboard");
  document.querySelector("#planTab").classList.toggle("hidden", tab !== "plan");
  document.querySelector("#historyTab").classList.toggle("hidden", tab !== "history");
  document.querySelector("#settingsTab").classList.toggle("hidden", tab !== "settings");
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  if (tab === "history") loadHistory().catch(showError);
}

function renderSnapshot(snapshot) {
  setBaseCurrency(snapshot.baseCurrency ?? dashboardState?.user?.base_currency ?? "THB");
  const dayRemaining = snapshot.dayRemaining ?? snapshot.safeToSpendPerDay;
  const dayProgress = snapshot.progress?.day ?? { percent: snapshot.dayProgressPercent ?? 0, state: "good" };
  const hero = document.querySelector(".hero-metric");
  if (hero) hero.dataset.state = dayProgress.state ?? "good";
  setText("#safeToSpend", moneyBase(dayRemaining));
  setText("#safeToSpendDisplay", moneyDisplay(snapshot.display?.dayRemaining ?? snapshot.display?.safeToSpendPerDay, snapshot.display?.currency));
  renderDashboardCards(document.querySelector("#dashboardCards"), buildDashboardCards(snapshot, {
    t,
    moneyBase,
    moneyDisplay,
    percent: (value) => `${percentNumber.format(Number(value ?? 0))}%`
  }));

  const status = document.querySelector("#heroStatus");
  status.textContent = {
    above_plan: t("dashboard.abovePlan"),
    below_plan: t("dashboard.belowPlan"),
    on_plan: t("dashboard.withinPlan")
  }[snapshot.status] ?? snapshot.status;
  status.classList.toggle("above", snapshot.status === "above_plan");
  status.classList.toggle("below", snapshot.status === "below_plan");
}

function renderSettings(user) {
  currentLanguage = user.interface_language ?? "en";
  applyTheme("light");
  setBaseCurrency(user.base_currency ?? "THB");
  applyLanguage(currentLanguage);
  document.querySelector("#budgetInput").value = Math.round(Number(user.monthly_budget_amount ?? 45000));
  document.querySelector("#currentMonthBudgetInput").value = Math.round(Number(dashboardState?.currentMonthBudget?.amount ?? user.monthly_budget_amount ?? 45000));
  document.querySelector("#weeklyBudgetInput").value = user.weekly_budget_amount == null ? "" : Math.round(Number(user.weekly_budget_amount));
  document.querySelector("#baseCurrencyInput").value = user.base_currency ?? "THB";
  document.querySelector("#displayCurrencyInput").value = user.display_currency ?? "USD";
  document.querySelector("#interfaceLanguageInput").value = currentLanguage;
  document.querySelector("#interfaceThemeInput").value = "light";
  document.querySelector("#usdThbRateInput").value = Number(user.usd_thb_rate ?? 32.65);
  document.querySelector("#budgetAdviceInput").checked = user.budget_advice_enabled !== false;
  updateCurrencyFlags();
}

function renderPlannedMonthSummary(items) {
  const summary = calculatePlannedMonthSummary(items);
  const baseCurrency = dashboardState?.user?.base_currency ?? dashboardState?.snapshot?.baseCurrency ?? "THB";
  const total = plannedSummaryMoneyParts(summary.total, baseCurrency, summary.display.total, summary.display.currency);
  const paid = plannedSummaryMoneyParts(summary.paid, baseCurrency, summary.display.paid, summary.display.currency);
  const remaining = plannedSummaryMoneyParts(summary.remaining, baseCurrency, summary.display.remaining, summary.display.currency);

  setHtml("#plannedReserveTotal", plannedSummaryMoneyHtml(total));
  setHtml("#plannedReservePaidRemaining", currentLanguage === "ru"
    ? `Оплачено ${plannedSummaryMoneyHtml(paid)} · осталось ${plannedSummaryMoneyHtml(remaining)}`
    : `Paid ${plannedSummaryMoneyHtml(paid)} · remaining ${plannedSummaryMoneyHtml(remaining)}`);
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

function renderPlannedNotice(items) {
  const notice = document.querySelector("#plannedNotice");
  const due = items.find((item) => isDueToday(item) && !isPlannedPaid(item) && !hiddenNoticeIds.has(String(item.id)));
  if (!due) {
    notice.classList.add("hidden");
    notice.innerHTML = "";
    return;
  }
  notice.classList.remove("hidden");
  notice.innerHTML = `
    <div class="notice-title">
      <span>${t("plan.todayDue")}</span>
      <strong>${moneyBase(due.amount_base ?? due.amount)}</strong>
    </div>
    <div class="expense-meta">${escapeHtml(due.description)} · ${escapeHtml(categoryLabel(due.category_slug, currentLanguage))}</div>
    <div class="button-row">
      <button type="button" data-pay-planned="${due.id}">${t("actions.pay")}</button>
      <button type="button" class="ghost-button" data-hide-notice="${due.id}">${currentLanguage === "ru" ? "Позже" : "Later"}</button>
      <button type="button" class="ghost-button" data-edit-planned="${due.id}">${t("actions.edit")}</button>
    </div>
  `;
  bindPlannedActions(notice, items);
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
  list.innerHTML = expenses.map(expenseRow).join("");
  bindExpenseActions(list, expenses);
}

function renderHistory(expenses) {
  const list = document.querySelector("#historyList");
  if (!expenses.length) {
    list.innerHTML = `<div class="empty">${t("history.empty")}</div>`;
    return;
  }

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
  title.textContent = t("history.inboxCount", { count: drafts.length });
  list.innerHTML = drafts.map((draft) => {
    const total = inboxDraftTotal(draft);
    const description = inboxDraftDescription(draft);
    return `
      <article class="expense-row" style="--category-color: #b84d7a">
        <div class="expense-main">
          <div class="expense-title">${escapeHtml(description)}</div>
          <div class="expense-meta">${formatDate(draft.created_at, currentLanguage)} · ${draft.items.length} ${t("history.rows")} · ${moneyBase(total)}</div>
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
  title.textContent = t("history.inboxCount", { count: drafts.length });
  list.innerHTML = drafts.slice(0, 2).map((draft) => {
    const total = inboxDraftTotal(draft);
    const description = inboxDraftDescription(draft);
    return `
      <article class="expense-row inbox-draft-row" data-inbox-location="dashboard" data-draft-row="${draft.id}" style="--category-color: #b84d7a">
        <div class="expense-main">
          <div class="expense-title">${escapeHtml(description)}</div>
          <div class="expense-meta">${formatDate(draft.created_at, currentLanguage)} · ${draft.items.length} ${t("history.rows")} · ${moneyBase(total)}</div>
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
        <div class="expense-meta">${formatDate(expense.spent_at, currentLanguage)} · ${escapeHtml(categoryLabel(expense.category_slug, currentLanguage))}</div>
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
      await api(`/api/expenses/${expense.id}`, { method: "DELETE", body: { telegramUserId } });
      await loadDashboard();
      await loadHistory();
      showToast(t("toast.expenseDeleted"));
    });
  });
}

function renderPlannedForm(item = {}) {
  const form = document.querySelector("#plannedForm");
  const dueDays = Array.isArray(item.due_days) && item.due_days.length ? item.due_days.join(", ") : (item.due_day ?? "");
  const plannedCurrency = defaultPlannedCurrency(item, dashboardState?.user?.base_currency ?? "THB");
  form.innerHTML = `
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
        <input name="planned-due_date" type="date" value="${item.due_date ? String(item.due_date).slice(0, 10) : ""}" />
      </label>
    </div>
    <label>
      <span>${t("forms.tagsComma")}</span>
      <input name="planned-tags" value="${escapeAttribute((item.tags ?? []).join(", "))}" />
    </label>
    <div class="button-row">
      <button type="submit">${item.id ? t("plan.saveExisting") : t("plan.saveNew")}</button>
      <button type="button" class="ghost-button" id="resetPlannedForm">${t("plan.reset")}</button>
      <button type="button" class="ghost-button" id="cancelPlannedForm">${t("actions.close")}</button>
    </div>
  `;
  form.onsubmit = (event) => savePlanned(event, item.id);
  form.querySelector("#resetPlannedForm").addEventListener("click", () => renderPlannedForm());
  form.querySelector("#cancelPlannedForm").addEventListener("click", () => {
    renderPlannedForm();
    form.classList.add("hidden");
  });
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
  list.innerHTML = items.map((item) => `
    <article class="expense-row" style="--category-color: ${categoryColor(item.category_slug)}">
      <div class="expense-main">
        <div class="expense-title">${escapeHtml(item.description)}</div>
        <div class="expense-meta">${recurrenceLabel(item)} · ${escapeHtml(categoryLabel(item.category_slug, currentLanguage))}${isPlannedPaid(item) ? ` · ${t("plan.paidSuffix")}` : ""}</div>
      </div>
      <div class="expense-actions">
        <div class="expense-amount">${formatMoney(item.amount, item.currency)}
          <em>${moneyDisplay(item.display?.amount, item.display?.currency)}</em>
        </div>
        <div class="button-row compact">
          <button type="button" data-pay-planned="${item.id}"${isPlannedPaid(item) ? " disabled" : ""}>${isPlannedPaid(item) ? t("actions.paid") : t("actions.pay")}</button>
          <button type="button" class="ghost-button" data-edit-planned="${item.id}">${t("actions.edit")}</button>
          <button type="button" class="danger-button" data-delete-planned="${item.id}">${t("actions.disable")}</button>
        </div>
      </div>
    </article>
  `).join("");
  bindPlannedActions(list, items);
}

function bindPlannedActions(container, items) {
  container.querySelectorAll("[data-edit-planned]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = items.find((planned) => String(planned.id) === button.dataset.editPlanned);
      switchTab("plan");
      renderPlannedForm(item);
      document.querySelector("#plannedForm").classList.remove("hidden");
      document.querySelector("#plannedForm").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  container.querySelectorAll("[data-delete-planned]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/planned-expenses/${button.dataset.deletePlanned}`, { method: "DELETE", body: { telegramUserId } });
      renderPlannedForm();
      await loadDashboard();
      showToast(t("toast.plannedDisabled"));
    });
  });
  container.querySelectorAll("[data-pay-planned]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/planned-expenses/${button.dataset.payPlanned}/pay`, { method: "POST", body: { telegramUserId } });
      await loadDashboard();
      await loadHistory();
      showToast(t("toast.paymentSaved"));
    });
  });
  container.querySelectorAll("[data-hide-notice]").forEach((button) => {
    button.addEventListener("click", () => {
      hiddenNoticeIds.add(button.dataset.hideNotice);
      renderPlannedNotice(dashboardState.plannedExpenses ?? []);
    });
  });
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
        <button type="submit">${t("actions.saveDraft")}</button>
        <button type="button" id="confirmDraftButton">${t("actions.confirm")}</button>
        <button type="button" class="ghost-button" id="closeDraftButton">${t("actions.close")}</button>
      </div>
    </div>
  `;
  form.onsubmit = saveDraft;
  form.querySelector("#confirmDraftButton").addEventListener("click", confirmDraft);
  form.querySelector("#closeDraftButton").addEventListener("click", closeDraftEditor);
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
  document.querySelector("#draftEditorSection").classList.add("hidden");
  draftState = null;
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
        <input name="${prefix}-spent_at" type="datetime-local" value="${dateTimeLocal(item.spent_at)}" required />
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
        interfaceTheme: "light",
        budgetAdviceEnabled: document.querySelector("#budgetAdviceInput").checked,
        usdThbRate: Number(document.querySelector("#usdThbRateInput").value)
      }
    }
  });
  await loadDashboard();
  showToast(t("toast.settingsSaved"));
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
  showToast(t("toast.settingsSaved"));
}

async function saveDraft(event) {
  event.preventDefault();
  await saveDraftItems({ showFeedback: true });
}

async function saveDraftItems(options = {}) {
  const items = draftState.items.map((item, index) => collectItem(`draft-${index}`, item));
  const data = await api(`/api/drafts/${draftState.id}`, { method: "PATCH", body: { telegramUserId, items } });
  draftState = data.draft;
  renderDraftEditor(draftState);
  if (options.showFeedback) showToast(t("toast.draftSaved"));
}

async function confirmDraft() {
  await saveDraftItems();
  await api(`/api/drafts/${draftState.id}/confirm`, { method: "POST", body: { telegramUserId } });
  document.querySelector("#draftEditorSection").classList.add("hidden");
  await loadDashboard();
  await loadHistory();
  showToast(t("toast.draftConfirmed"));
  switchTab(draftReturnTab);
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

async function savePlanned(event, plannedId) {
  event.preventDefault();
  const method = plannedId ? "PATCH" : "POST";
  const path = plannedId ? `/api/planned-expenses/${plannedId}` : "/api/planned-expenses";
  await api(path, { method, body: { telegramUserId, plannedExpense: collectPlanned() } });
  renderPlannedForm();
  document.querySelector("#plannedForm").classList.add("hidden");
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

function updateCurrencyFlags() {
  const pairs = [
    ["#baseCurrencyFlag", "#baseCurrencyInput", "currency"],
    ["#displayCurrencyFlag", "#displayCurrencyInput", "currency"],
    ["#interfaceLanguageFlag", "#interfaceLanguageInput", "language"]
  ];
  for (const [flagSelector, inputSelector, type] of pairs) {
    const flag = document.querySelector(flagSelector);
    const select = document.querySelector(inputSelector);
    if (!flag || !select) continue;
    if (type === "language") {
      flag.dataset.language = select.value;
    } else {
      flag.dataset.currency = select.value;
    }
  }
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
    button.textContent = t(`screen.${button.dataset.tab}`);
  });
  setOptionalText("#settingsTab h2", t("settings.title"));
  const labels = [
    ["#budgetInput", "settings.monthlyBudget"],
    ["#currentMonthBudgetInput", "settings.currentMonthBudget"],
    ["#weeklyBudgetInput", "settings.weeklyBudget"],
    ["#baseCurrencyInput", "settings.baseCurrency"],
    ["#displayCurrencyInput", "settings.displayCurrency"],
    ["#interfaceLanguageInput", "settings.interfaceLanguage"]
  ];
  for (const [selector, key] of labels) {
    const label = document.querySelector(selector)?.closest("label")?.querySelector("span");
    if (label) label.textContent = t(key);
  }
  const save = document.querySelector("#settingsForm button[type='submit']");
  if (save) save.textContent = t("actions.save");
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
  return plannedRecurrenceLabel(item, (value) => formatDate(value, currentLanguage), currentLanguage);
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


