const params = new URLSearchParams(window.location.search);
const telegramUserId = params.get("telegramUserId") || window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
const draftId = params.get("draftId");

const categories = [
  ["food_cafe", "Еда и кафе", "#d85d35"],
  ["groceries", "Продукты", "#c28f2c"],
  ["home", "Дом", "#9a6a30"],
  ["transport", "Байк / транспорт", "#2f80c0"],
  ["health", "Тело / здоровье", "#b84d7a"],
  ["sport_activities", "Спорт / активности", "#4e9b55"],
  ["gear", "Вещи / экипировка", "#7a6a55"],
  ["travel", "Путешествия", "#1d7f75"],
  ["subscriptions", "Подписки / связь", "#6a62c8"],
  ["gifts_help", "Подарки / помощь", "#c46a8a"],
  ["entertainment", "Развлечения", "#d87135"],
  ["other", "Другое", "#756b61"]
];

const money = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const statusLabels = {
  above_plan: "чуть быстрее плана",
  below_plan: "ниже плана",
  on_plan: "в плане"
};
const screenTitles = {
  dashboard: "Dashboard",
  history: "History",
  settings: "Settings"
};

let dashboardState = null;
let draftState = null;
let historyState = [];
let hiddenNoticeIds = new Set();

if (window.Telegram?.WebApp) {
  window.Telegram.WebApp.ready();
  window.Telegram.WebApp.expand();
}

document.querySelector("#settingsForm").addEventListener("submit", saveSettings);
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

load().catch(showError);

async function load() {
  if (!telegramUserId) throw new Error("Нет Telegram user id. Откройте Mini App из бота.");
  renderPlannedForm();
  await loadDashboard();
  await loadHistory();
  if (draftId) await loadDraft(draftId);
}

async function loadDashboard() {
  const data = await api(`/api/dashboard?telegramUserId=${encodeURIComponent(telegramUserId)}`);
  dashboardState = data;
  renderSnapshot(data.snapshot);
  renderSettings(data.user);
  renderPlannedNotice(data.plannedExpenses ?? []);
  renderTopCategories(data.topCategories ?? [], data.snapshot.month);
  renderPlannedExpenses(data.plannedExpenses ?? []);
  renderLatest(data.latestExpenses ?? []);
}

async function loadHistory() {
  const search = document.querySelector("#historySearch").value.trim();
  const data = await api(`/api/expenses?telegramUserId=${encodeURIComponent(telegramUserId)}&period=month&search=${encodeURIComponent(search)}`);
  historyState = data.expenses ?? [];
  renderHistory(historyState);
}

async function loadDraft(id) {
  const data = await api(`/api/drafts/${id}?telegramUserId=${encodeURIComponent(telegramUserId)}`);
  draftState = data.draft;
  renderDraftEditor(draftState);
}

function switchTab(tab) {
  document.querySelector("#dashboardTab").classList.toggle("hidden", tab !== "dashboard");
  document.querySelector("#historyTab").classList.toggle("hidden", tab !== "history");
  document.querySelector("#settingsTab").classList.toggle("hidden", tab !== "settings");
  document.querySelector("#screenTitle").textContent = screenTitles[tab] ?? "Dashboard";
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  if (tab === "history") loadHistory().catch(showError);
}

function renderSnapshot(snapshot) {
  setText("#safeToSpend", moneyBase(snapshot.safeToSpendPerDay));
  setText("#safeToSpendDisplay", moneyDisplay(snapshot.display?.safeToSpendPerDay, snapshot.display?.currency));
  setText("#today", moneyBase(snapshot.today));
  setText("#todayDisplay", moneyDisplay(snapshot.display?.today, snapshot.display?.currency));
  setText("#week", moneyBase(snapshot.week));
  setText("#weekDisplay", moneyDisplay(snapshot.display?.week, snapshot.display?.currency));
  setText("#month", moneyBase(snapshot.month));
  setText("#monthDisplay", moneyDisplay(snapshot.display?.month, snapshot.display?.currency));
  setText("#freeRemaining", moneyBase(snapshot.freeRemaining));
  setText("#freeRemainingDisplay", moneyDisplay(snapshot.display?.freeRemaining, snapshot.display?.currency));

  const status = document.querySelector("#status");
  status.textContent = statusLabels[snapshot.status] ?? snapshot.status;
  status.classList.toggle("above", snapshot.status === "above_plan");
  status.classList.toggle("below", snapshot.status === "below_plan");
}

function renderSettings(user) {
  document.querySelector("#budgetInput").value = Math.round(Number(user.monthly_budget_amount ?? 45000));
  document.querySelector("#baseCurrencyInput").value = user.base_currency ?? "THB";
  document.querySelector("#displayCurrencyInput").value = user.display_currency ?? "USD";
  document.querySelector("#usdThbRateInput").value = Number(user.usd_thb_rate ?? 36);
}

function renderPlannedNotice(items) {
  const notice = document.querySelector("#plannedNotice");
  const due = items.find((item) => isDueToday(item) && !item.paid_month && !hiddenNoticeIds.has(String(item.id)));
  if (!due) {
    notice.classList.add("hidden");
    notice.innerHTML = "";
    return;
  }
  notice.classList.remove("hidden");
  notice.innerHTML = `
    <div class="notice-title">
      <span>Сегодня плановая оплата</span>
      <strong>${moneyBase(due.amount_base ?? due.amount)}</strong>
    </div>
    <div class="expense-meta">${escapeHtml(due.description)} · ${escapeHtml(categoryLabel(due.category_slug))}</div>
    <div class="button-row">
      <button type="button" data-pay-planned="${due.id}">Оплачено</button>
      <button type="button" class="ghost-button" data-hide-notice="${due.id}">Позже</button>
      <button type="button" class="ghost-button" data-edit-planned="${due.id}">Изменить</button>
    </div>
  `;
  bindPlannedActions(notice, items);
}

function renderTopCategories(items, monthTotal) {
  const list = document.querySelector("#topCategories");
  if (!items.length) {
    list.innerHTML = `<div class="empty">Пока нет категорий.</div>`;
    return;
  }
  list.innerHTML = items.map((item) => {
    const total = Number(item.total);
    const percent = monthTotal > 0 ? Math.round((total / monthTotal) * 100) : 0;
    return `
      <div class="bar-row" style="--category-color: ${categoryColor(item.category_slug)}">
        <div class="bar-row-top">
          <span>${escapeHtml(categoryLabel(item.category_slug))}</span>
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
    list.innerHTML = `<div class="empty">Пока нет расходов.</div>`;
    return;
  }
  list.innerHTML = expenses.map(expenseRow).join("");
  bindExpenseActions(list, expenses);
}

function renderHistory(expenses) {
  const list = document.querySelector("#historyList");
  if (!expenses.length) {
    list.innerHTML = `<div class="empty">Ничего не найдено.</div>`;
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

function expenseRow(expense) {
  return `
    <article class="expense-row" style="--category-color: ${categoryColor(expense.category_slug)}">
      <div class="expense-main">
        <div class="expense-title">${escapeHtml(expense.description)}</div>
        <div class="expense-meta">${formatDate(expense.spent_at)} · ${escapeHtml(categoryLabel(expense.category_slug))}</div>
      </div>
      <div class="expense-actions">
        <div class="expense-amount">${money.format(Number(expense.amount_original))} ${escapeHtml(expense.currency_original)}
          <em>${moneyDisplay(expense.display?.amount, expense.display?.currency)}</em>
        </div>
        <div class="button-row compact">
          <button type="button" class="ghost-button" data-edit-expense="${expense.id}">Изменить</button>
          <button type="button" class="danger-button" data-delete-expense="${expense.id}">Удалить</button>
        </div>
      </div>
    </article>
  `;
}

function bindExpenseActions(container, expenses) {
  container.querySelectorAll("[data-edit-expense]").forEach((button) => {
    button.addEventListener("click", () => {
      const expense = expenses.find((item) => String(item.id) === button.dataset.editExpense);
      renderExpenseEditor(expense);
    });
  });
  container.querySelectorAll("[data-delete-expense]").forEach((button) => {
    button.addEventListener("click", async () => {
      const expense = expenses.find((item) => String(item.id) === button.dataset.deleteExpense);
      if (!window.confirm(`Удалить расход "${expense.description}"?`)) return;
      await api(`/api/expenses/${expense.id}`, { method: "DELETE", body: { telegramUserId } });
      await loadDashboard();
      await loadHistory();
    });
  });
}

function renderPlannedForm(item = {}) {
  const form = document.querySelector("#plannedForm");
  form.innerHTML = `
    <div class="field-grid">
      <label>
        <span>Описание</span>
        <input name="planned-description" value="${escapeAttribute(item.description ?? "")}" placeholder="ChatGPT, аренда, английский" required />
      </label>
      <label>
        <span>Сумма</span>
        <input name="planned-amount" type="number" min="0.01" step="0.01" value="${item.amount ?? ""}" required />
      </label>
    </div>
    <div class="field-grid">
      <label>
        <span>Валюта</span>
        <select name="planned-currency">${option("THB", item.currency)}${option("USD", item.currency)}${option("RUB", item.currency)}</select>
      </label>
      <label>
        <span>Повтор</span>
        <select name="planned-recurrence">
          ${option("monthly", item.recurrence, "Раз в месяц")}
          ${option("weekly", item.recurrence, "Раз в неделю")}
          ${option("twice_monthly", item.recurrence, "2 раза в месяц")}
          ${option("one_off", item.recurrence, "Один раз")}
        </select>
      </label>
    </div>
    <div class="field-grid">
      <label>
        <span>Категория</span>
        <select name="planned-category_slug">${categories.map(([slug, label]) => option(slug, item.category_slug, label)).join("")}</select>
      </label>
      <label>
        <span>День месяца</span>
        <input name="planned-due_day" type="number" min="1" max="31" value="${item.due_day ?? ""}" />
      </label>
    </div>
    <label>
      <span>Теги через запятую</span>
      <input name="planned-tags" value="${escapeAttribute((item.tags ?? []).join(", "))}" />
    </label>
    <div class="button-row">
      <button type="submit">${item.id ? "Сохранить плановую" : "Добавить плановую"}</button>
      <button type="button" class="ghost-button" id="resetPlannedForm">Очистить</button>
    </div>
  `;
  form.onsubmit = (event) => savePlanned(event, item.id);
  form.querySelector("#resetPlannedForm").addEventListener("click", () => renderPlannedForm());
}

function renderPlannedExpenses(items) {
  const list = document.querySelector("#plannedExpenses");
  if (!items.length) {
    list.innerHTML = `<div class="empty">Плановых трат пока нет.</div>`;
    return;
  }
  list.innerHTML = items.map((item) => `
    <article class="expense-row" style="--category-color: ${categoryColor(item.category_slug)}">
      <div class="expense-main">
        <div class="expense-title">${escapeHtml(item.description)}</div>
        <div class="expense-meta">${recurrenceLabel(item.recurrence)} · ${escapeHtml(categoryLabel(item.category_slug))}${item.paid_month ? " · оплачено" : ""}</div>
      </div>
      <div class="expense-actions">
        <div class="expense-amount">${money.format(Number(item.amount))} ${escapeHtml(item.currency)}
          <em>${moneyDisplay(item.display?.amount, item.display?.currency)}</em>
        </div>
        <div class="button-row compact">
          <button type="button" data-pay-planned="${item.id}"${item.paid_month ? " disabled" : ""}>Оплачено</button>
          <button type="button" class="ghost-button" data-edit-planned="${item.id}">Изменить</button>
          <button type="button" class="danger-button" data-delete-planned="${item.id}">Отключить</button>
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
    });
  });
  container.querySelectorAll("[data-pay-planned]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/planned-expenses/${button.dataset.payPlanned}/pay`, { method: "POST", body: { telegramUserId } });
      await loadDashboard();
      await loadHistory();
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
  const form = document.querySelector("#draftForm");
  section.classList.remove("hidden");
  form.innerHTML = `
    <div class="form-stack">
      ${draft.items.map((item, index) => editableItemFields(item, `draft-${index}`, index)).join("")}
      <div class="button-row">
        <button type="submit">Сохранить черновик</button>
        <button type="button" id="confirmDraftButton">Подтвердить</button>
      </div>
    </div>
  `;
  form.onsubmit = saveDraft;
  form.querySelector("#confirmDraftButton").addEventListener("click", confirmDraft);
}

function renderExpenseEditor(expense) {
  if (!expense) return;
  switchTab("dashboard");
  const section = document.querySelector("#expenseEditorSection");
  const form = document.querySelector("#expenseForm");
  section.classList.remove("hidden");
  form.innerHTML = `
    <div class="form-stack">
      ${editableItemFields({
        amount: expense.amount_original,
        currency: expense.currency_original,
        description: expense.description,
        category_slug: expense.category_slug,
        tags: expense.tags ?? [],
        spent_at: expense.spent_at
      }, "expense", 0)}
      <div class="button-row">
        <button type="submit">Сохранить расход</button>
      </div>
    </div>
  `;
  form.onsubmit = (event) => saveExpense(event, expense.id);
  section.scrollIntoView({ behavior: "smooth", block: "start" });
}

function editableItemFields(item, prefix, index) {
  return `
    <fieldset class="edit-card" data-index="${index}">
      <label>
        <span>Описание</span>
        <input name="${prefix}-description" value="${escapeAttribute(item.description ?? "")}" required />
      </label>
      <div class="field-grid">
        <label>
          <span>Сумма</span>
          <input name="${prefix}-amount" type="number" min="0.01" step="0.01" value="${Number(item.amount)}" required />
        </label>
        <label>
          <span>Валюта</span>
          <select name="${prefix}-currency">${option("THB", item.currency)}${option("USD", item.currency)}${option("RUB", item.currency)}</select>
        </label>
      </div>
      <label>
        <span>Категория</span>
        <select name="${prefix}-category_slug">${categories.map(([slug, label]) => option(slug, item.category_slug, label)).join("")}</select>
      </label>
      <label>
        <span>Дата и время</span>
        <input name="${prefix}-spent_at" type="datetime-local" value="${dateTimeLocal(item.spent_at)}" required />
      </label>
      <label>
        <span>Теги через запятую</span>
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
        baseCurrency: document.querySelector("#baseCurrencyInput").value,
        displayCurrency: document.querySelector("#displayCurrencyInput").value,
        usdThbRate: Number(document.querySelector("#usdThbRateInput").value)
      }
    }
  });
  await loadDashboard();
}

async function saveDraft(event) {
  event.preventDefault();
  await saveDraftItems();
}

async function saveDraftItems() {
  const items = draftState.items.map((item, index) => collectItem(`draft-${index}`, item));
  const data = await api(`/api/drafts/${draftState.id}`, { method: "PATCH", body: { telegramUserId, items } });
  draftState = data.draft;
  renderDraftEditor(draftState);
}

async function confirmDraft() {
  await saveDraftItems();
  await api(`/api/drafts/${draftState.id}/confirm`, { method: "POST", body: { telegramUserId } });
  document.querySelector("#draftEditorSection").classList.add("hidden");
  await loadDashboard();
  await loadHistory();
}

async function saveExpense(event, expenseId) {
  event.preventDefault();
  await api(`/api/expenses/${expenseId}`, { method: "PATCH", body: { telegramUserId, expense: collectItem("expense", {}) } });
  document.querySelector("#expenseEditorSection").classList.add("hidden");
  await loadDashboard();
  await loadHistory();
}

async function savePlanned(event, plannedId) {
  event.preventDefault();
  const method = plannedId ? "PATCH" : "POST";
  const path = plannedId ? `/api/planned-expenses/${plannedId}` : "/api/planned-expenses";
  await api(path, { method, body: { telegramUserId, plannedExpense: collectPlanned() } });
  renderPlannedForm();
  document.querySelector("#plannedForm").classList.add("hidden");
  await loadDashboard();
}

function collectItem(prefix, original) {
  return {
    amount: Number(input(`${prefix}-amount`).value),
    currency: input(`${prefix}-currency`).value,
    description: input(`${prefix}-description`).value.trim(),
    category_slug: input(`${prefix}-category_slug`).value,
    spent_at: new Date(input(`${prefix}-spent_at`).value).toISOString(),
    tags: input(`${prefix}-tags`).value.split(",").map((tag) => tag.trim()).filter(Boolean),
    confidence: original.confidence ?? 1,
    needs_review: false
  };
}

function collectPlanned() {
  return {
    amount: Number(input("planned-amount").value),
    currency: input("planned-currency").value,
    description: input("planned-description").value.trim(),
    category_slug: input("planned-category_slug").value,
    recurrence: input("planned-recurrence").value,
    due_day: input("planned-due_day").value ? Number(input("planned-due_day").value) : null,
    tags: input("planned-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean),
    active: true
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? "Не удалось выполнить запрос.");
  }
  return response.json();
}

function groupByDay(expenses) {
  const groups = new Map();
  for (const expense of expenses) {
    const label = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "long" }).format(new Date(expense.spent_at));
    if (!groups.has(label)) groups.set(label, { label, total: 0, items: [] });
    const group = groups.get(label);
    group.total += Number(expense.amount_base ?? expense.amount_original);
    group.items.push(expense);
  }
  return [...groups.values()];
}

function isDueToday(item) {
  const today = new Date();
  if (item.recurrence === "one_off" && item.due_date) {
    return new Date(item.due_date).toDateString() === today.toDateString();
  }
  return Number(item.due_day) === today.getDate();
}

function input(name) {
  return document.querySelector(`[name="${name}"]`);
}

function option(value, selected, label = value) {
  return `<option value="${value}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function categoryLabel(slug) {
  return categories.find(([value]) => value === slug)?.[1] ?? slug;
}

function categoryColor(slug) {
  return categories.find(([value]) => value === slug)?.[2] ?? "#756b61";
}

function recurrenceLabel(value) {
  return {
    monthly: "раз в месяц",
    weekly: "раз в неделю",
    twice_monthly: "2 раза в месяц",
    one_off: "один раз"
  }[value] ?? value;
}

function moneyBase(value) {
  return `${money.format(Number(value ?? 0))} THB`;
}

function moneyDisplay(value, currency = "USD") {
  if (value == null || Number.isNaN(Number(value))) return "";
  const prefix = currency === "USD" ? "~$" : "";
  const suffix = currency === "USD" ? "" : ` ${currency}`;
  return `${prefix}${money.format(Number(value))}${suffix}`;
}

function setText(selector, text) {
  document.querySelector(selector).textContent = text;
}

function showError(error) {
  document.querySelector("#latestExpenses").innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function dateTimeLocal(value) {
  const date = new Date(value ?? Date.now());
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("\n", " ");
}
