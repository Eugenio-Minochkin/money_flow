const params = new URLSearchParams(window.location.search);
const telegramUserId = params.get("telegramUserId") || window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
const draftId = params.get("draftId");

const categories = [
  ["food_cafe", "Еда и кафе"],
  ["groceries", "Продукты"],
  ["home", "Дом"],
  ["transport", "Байк / транспорт"],
  ["health", "Тело / здоровье"],
  ["sport_activities", "Спорт / активности"],
  ["gear", "Вещи / экипировка"],
  ["travel", "Путешествия"],
  ["subscriptions", "Подписки / связь"],
  ["gifts_help", "Подарки / помощь"],
  ["entertainment", "Развлечения"],
  ["other", "Другое"]
];

const money = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const statusLabels = {
  above_plan: "чуть быстрее плана",
  below_plan: "ниже плана",
  on_plan: "в плане"
};

let dashboardState = null;
let draftState = null;

if (window.Telegram?.WebApp) {
  window.Telegram.WebApp.ready();
  window.Telegram.WebApp.expand();
}

document.querySelector("#budgetForm").addEventListener("submit", saveBudget);

load().catch(showError);

async function load() {
  if (!telegramUserId) throw new Error("Нет Telegram user id. Откройте Mini App из бота.");
  await loadDashboard();
  if (draftId) await loadDraft(draftId);
}

async function loadDashboard() {
  const data = await api(`/api/dashboard?telegramUserId=${encodeURIComponent(telegramUserId)}`);
  dashboardState = data;
  renderSnapshot(data.snapshot);
  renderLatest(data.latestExpenses);
}

async function loadDraft(id) {
  const data = await api(`/api/drafts/${id}?telegramUserId=${encodeURIComponent(telegramUserId)}`);
  draftState = data.draft;
  renderDraftEditor(draftState);
}

function renderSnapshot(snapshot) {
  setText("#safeToSpend", `${money.format(snapshot.safeToSpendPerDay)} THB`);
  setText("#today", `${money.format(snapshot.today)} THB`);
  setText("#month", `${money.format(snapshot.month)} THB`);
  setText("#budget", `${money.format(snapshot.monthlyBudget)} THB`);
  setText("#remaining", `${money.format(snapshot.remaining)} THB`);
  document.querySelector("#budgetInput").value = Math.round(snapshot.monthlyBudget);

  const status = document.querySelector("#status");
  status.textContent = statusLabels[snapshot.status] ?? snapshot.status;
  status.classList.toggle("above", snapshot.status === "above_plan");
  status.classList.toggle("below", snapshot.status === "below_plan");
}

function renderLatest(expenses) {
  const list = document.querySelector("#latestExpenses");
  if (!expenses.length) {
    list.innerHTML = `<div class="empty">Пока нет расходов.</div>`;
    return;
  }

  list.innerHTML = expenses.map((expense) => `
    <article class="expense-row">
      <div>
        <div class="expense-title">${escapeHtml(expense.description)}</div>
        <div class="expense-meta">${formatDate(expense.spent_at)} · ${categoryLabel(expense.category_slug)}</div>
      </div>
      <div class="expense-actions">
        <div class="expense-amount">${money.format(Number(expense.amount_original))} ${escapeHtml(expense.currency_original)}</div>
        <button type="button" class="ghost-button" data-edit-expense="${expense.id}">Изменить</button>
      </div>
    </article>
  `).join("");

  list.querySelectorAll("[data-edit-expense]").forEach((button) => {
    button.addEventListener("click", () => {
      const expense = dashboardState.latestExpenses.find((item) => String(item.id) === button.dataset.editExpense);
      renderExpenseEditor(expense);
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
        <input name="${prefix}-description" value="${escapeAttribute(item.description)}" />
      </label>
      <div class="field-grid">
        <label>
          <span>Сумма</span>
          <input name="${prefix}-amount" type="number" min="0.01" step="0.01" value="${Number(item.amount)}" />
        </label>
        <label>
          <span>Валюта</span>
          <select name="${prefix}-currency">
            ${option("THB", item.currency)}
            ${option("USD", item.currency)}
            ${option("RUB", item.currency)}
          </select>
        </label>
      </div>
      <label>
        <span>Категория</span>
        <select name="${prefix}-category_slug">
          ${categories.map(([slug, label]) => option(slug, item.category_slug, label)).join("")}
        </select>
      </label>
      <label>
        <span>Дата и время</span>
        <input name="${prefix}-spent_at" type="datetime-local" value="${dateTimeLocal(item.spent_at)}" />
      </label>
      <label>
        <span>Теги через запятую</span>
        <input name="${prefix}-tags" value="${escapeAttribute((item.tags ?? []).join(", "))}" />
      </label>
    </fieldset>
  `;
}

async function saveBudget(event) {
  event.preventDefault();
  const monthlyBudgetAmount = Number(document.querySelector("#budgetInput").value);
  await api("/api/settings/budget", {
    method: "PATCH",
    body: { telegramUserId, monthlyBudgetAmount }
  });
  await loadDashboard();
}

async function saveDraft(event) {
  event.preventDefault();
  const items = draftState.items.map((item, index) => collectItem(`draft-${index}`, item));
  const data = await api(`/api/drafts/${draftState.id}`, {
    method: "PATCH",
    body: { telegramUserId, items }
  });
  draftState = data.draft;
  renderDraftEditor(draftState);
}

async function confirmDraft() {
  await saveDraft(new Event("submit"));
  await api(`/api/drafts/${draftState.id}/confirm`, {
    method: "POST",
    body: { telegramUserId }
  });
  document.querySelector("#draftEditorSection").classList.add("hidden");
  await loadDashboard();
}

async function saveExpense(event, expenseId) {
  event.preventDefault();
  await api(`/api/expenses/${expenseId}`, {
    method: "PATCH",
    body: {
      telegramUserId,
      expense: collectItem("expense", {})
    }
  });
  document.querySelector("#expenseEditorSection").classList.add("hidden");
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

function input(name) {
  return document.querySelector(`[name="${name}"]`);
}

function option(value, selected, label = value) {
  return `<option value="${value}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function categoryLabel(slug) {
  return categories.find(([value]) => value === slug)?.[1] ?? slug;
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
  const date = new Date(value);
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
