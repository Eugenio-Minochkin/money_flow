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
  plan: "Plan",
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
  renderNextPlannedSummary(data.plannedExpenses ?? []);
  renderAnalytics(data.snapshot, data.analytics ?? {});
  renderTopCategories(data.topCategories ?? [], data.snapshot.month);
  renderPlannedExpenses(data.plannedExpenses ?? []);
  renderLatest(data.latestExpenses ?? []);
}

function renderAnalytics(snapshot, analytics) {
  setText("#forecastMonth", moneyBase(snapshot.forecastMonthTotal));
  setText("#forecastMonthDisplay", moneyDisplay(snapshot.display?.forecastMonthTotal, snapshot.display?.currency));

  const deviation = Number(snapshot.planDeviation ?? 0);
  const deviationRow = document.querySelector("#planDeviation").closest(".plan-row");
  deviationRow.classList.toggle("good", deviation < 0);
  deviationRow.classList.toggle("bad", deviation > 0);
  deviationRow.classList.toggle("neutral", deviation === 0);
  setText("#planDeviationLabel", deviation > 0 ? "Идешь выше плана" : deviation < 0 ? "Идешь ниже плана" : "Идешь по плану");
  setText("#planDeviation", deviation === 0 ? moneyBase(0) : `на ${moneyBase(Math.abs(deviation))}`);
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
      <span>Категория “Другое” уже ${warning.percent}% месяца</span>
      <strong>${moneyBase(warning.total)}</strong>
    </div>
    <div class="expense-meta">Стоит разобрать эти траты, чтобы статистика была полезнее.</div>
  `;
}

function renderNextPlannedSummary(items) {
  const block = document.querySelector("#nextPlannedSummary");
  const next = nextPlannedItem(items);
  if (!next) {
    block.classList.add("hidden");
    block.innerHTML = "";
    return;
  }
  block.classList.remove("hidden");
  block.innerHTML = `
    <div>
      <span>Следующая плановая</span>
      <strong>${escapeHtml(next.item.description)}</strong>
      <em>${formatDateOnly(next.date)} · ${moneyBase(next.item.amount_base ?? next.item.amount)}</em>
    </div>
    <button type="button" class="ghost-button" data-open-plan>Plan</button>
  `;
  block.querySelector("[data-open-plan]").addEventListener("click", () => switchTab("plan"));
}

function nextPlannedItem(items) {
  const now = new Date();
  return items
    .map((item) => ({ item, date: nextPlannedDate(item, now) }))
    .filter((entry) => entry.date)
    .sort((left, right) => left.date - right.date)[0] ?? null;
}

function nextPlannedDate(item, now) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const candidates = [];
  const addCandidate = (date) => {
    if (!date) return;
    date.setHours(0, 0, 0, 0);
    if (date >= today) candidates.push(date);
  };

  if (item.recurrence === "one_off" && item.due_date) {
    addCandidate(new Date(item.due_date));
  } else if (item.recurrence === "weekly") {
    const target = Number(item.weekday ?? 1);
    const current = today.getDay() === 0 ? 7 : today.getDay();
    const daysUntil = (target - current + 7) % 7;
    const date = new Date(today);
    date.setDate(today.getDate() + daysUntil);
    addCandidate(date);
  } else {
    const days = Array.isArray(item.due_days) && item.due_days.length ? item.due_days : [item.due_day].filter(Boolean);
    for (const day of days.map(Number)) {
      const date = new Date(today.getFullYear(), today.getMonth(), day);
      addCandidate(date);
      if (date < today) addCandidate(new Date(today.getFullYear(), today.getMonth() + 1, day));
    }
  }

  return candidates.sort((left, right) => left - right)[0] ?? null;
}

function renderLargestExpenses(analytics) {
  const list = document.querySelector("#largestExpenses");
  const items = [
    analytics.largestWeek ? ["Неделя", analytics.largestWeek] : null,
    analytics.largestMonth ? ["Месяц", analytics.largestMonth] : null
  ].filter(Boolean);
  if (!items.length) {
    list.innerHTML = `<div class="empty">Крупных трат пока нет.</div>`;
    return;
  }
  list.innerHTML = items.map(([label, expense]) => `
    <article class="expense-row" style="--category-color: ${categoryColor(expense.category_slug)}">
      <div class="expense-main">
        <div class="expense-title">${escapeHtml(label)} · ${escapeHtml(expense.description)}</div>
        <div class="expense-meta">${formatDate(expense.spent_at)} · ${escapeHtml(categoryLabel(expense.category_slug))}</div>
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
    list.innerHTML = `<div class="empty">Тегов пока нет.</div>`;
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
  document.querySelector("#planTab").classList.toggle("hidden", tab !== "plan");
  document.querySelector("#historyTab").classList.toggle("hidden", tab !== "history");
  document.querySelector("#settingsTab").classList.toggle("hidden", tab !== "settings");
  document.querySelector("#screenTitle").textContent = screenTitles[tab] ?? "Dashboard";
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  if (tab === "history") loadHistory().catch(showError);
}

function renderSnapshot(snapshot) {
  const dayRemaining = snapshot.dayRemaining ?? snapshot.safeToSpendPerDay;
  setText("#safeToSpend", moneyBase(dayRemaining));
  setText("#safeToSpendDisplay", moneyDisplay(snapshot.display?.dayRemaining ?? snapshot.display?.safeToSpendPerDay, snapshot.display?.currency));
  setText("#today", moneyBase(snapshot.today));
  setText("#todayDisplay", `план ${moneyBase(snapshot.dayPlanLimit ?? snapshot.dailyPlanLimit ?? 0)}`);
  setText("#todayRemaining", `еще ${moneyBase(dayRemaining)}`);
  setText("#todayProgressPercent", `${money.format(Number(snapshot.dayProgressPercent ?? 0))}%`);
  setProgress("#todayProgressBar", snapshot.progress?.day ?? { percent: snapshot.dayProgressPercent ?? 0, state: "good" });

  setText("#week", moneyBase(snapshot.week));
  setText("#weekDisplay", `план ${moneyBase(snapshot.weekPlanLimit ?? 0)}`);
  setText("#weekRemaining", `осталось ${moneyBase(snapshot.weekRemaining)}`);
  setText("#weekProgressPercent", `${money.format(Number(snapshot.weekProgressPercent ?? 0))}%`);
  setProgress("#weekProgressBar", snapshot.progress?.week ?? { percent: snapshot.weekProgressPercent ?? 0, state: "good" });

  setText("#month", moneyBase(snapshot.month));
  setText("#monthDisplay", `бюджет ${moneyBase(snapshot.monthlyBudget ?? 0)}`);
  setText("#monthRemaining", `осталось ${moneyBase(snapshot.monthRemaining ?? snapshot.remaining)}`);
  setText("#monthCardProgressPercent", `${money.format(Number(snapshot.budgetProgressPercent ?? 0))}%`);
  setProgress("#monthProgressBar", snapshot.progress?.month ?? { percent: snapshot.budgetProgressPercent ?? 0, state: "good" });
  setText("#freeRemaining", moneyBase(snapshot.freeRemaining));
  setText("#freeRemainingDisplay", moneyDisplay(snapshot.display?.freeRemaining, snapshot.display?.currency));

  const status = document.querySelector("#status");
  status.textContent = statusLabels[snapshot.status] ?? snapshot.status;
  status.classList.toggle("above", snapshot.status === "above_plan");
  status.classList.toggle("below", snapshot.status === "below_plan");
}

function renderSettings(user) {
  document.querySelector("#budgetInput").value = Math.round(Number(user.monthly_budget_amount ?? 45000));
  document.querySelector("#weeklyBudgetInput").value = user.weekly_budget_amount == null ? "" : Math.round(Number(user.weekly_budget_amount));
  document.querySelector("#baseCurrencyInput").value = user.base_currency ?? "THB";
  document.querySelector("#displayCurrencyInput").value = user.display_currency ?? "USD";
  document.querySelector("#usdThbRateInput").value = Number(user.usd_thb_rate ?? 32.65);
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
      showToast("Расход удален");
    });
  });
}

function renderPlannedForm(item = {}) {
  const form = document.querySelector("#plannedForm");
  const dueDays = Array.isArray(item.due_days) && item.due_days.length ? item.due_days.join(", ") : (item.due_day ?? "");
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
      <label data-recurrence-field="monthly">
        <span>День месяца</span>
        <input name="planned-due_day" type="number" min="1" max="31" value="${item.due_day ?? ""}" />
      </label>
      <label data-recurrence-field="twice_monthly">
        <span>Дни месяца</span>
        <input name="planned-due_days" value="${escapeAttribute(dueDays)}" placeholder="4, 18" />
      </label>
      <label data-recurrence-field="weekly">
        <span>День недели</span>
        <select name="planned-weekday">${weekdayOptions(item.weekday)}</select>
      </label>
      <label data-recurrence-field="one_off">
        <span>Дата оплаты</span>
        <input name="planned-due_date" type="date" value="${item.due_date ? String(item.due_date).slice(0, 10) : ""}" />
      </label>
    </div>
    <label>
      <span>Теги через запятую</span>
      <input name="planned-tags" value="${escapeAttribute((item.tags ?? []).join(", "))}" />
    </label>
    <div class="button-row">
      <button type="submit">${item.id ? "Сохранить плановую" : "Добавить плановую"}</button>
      <button type="button" class="ghost-button" id="resetPlannedForm">Очистить</button>
      <button type="button" class="ghost-button" id="cancelPlannedForm">Закрыть</button>
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
    list.innerHTML = `<div class="empty">Плановых трат пока нет.</div>`;
    return;
  }
  list.innerHTML = items.map((item) => `
    <article class="expense-row" style="--category-color: ${categoryColor(item.category_slug)}">
      <div class="expense-main">
        <div class="expense-title">${escapeHtml(item.description)}</div>
        <div class="expense-meta">${recurrenceLabel(item)} · ${escapeHtml(categoryLabel(item.category_slug))}${isPlannedPaid(item) ? " · оплачено" : ""}</div>
      </div>
      <div class="expense-actions">
        <div class="expense-amount">${money.format(Number(item.amount))} ${escapeHtml(item.currency)}
          <em>${moneyDisplay(item.display?.amount, item.display?.currency)}</em>
        </div>
        <div class="button-row compact">
          <button type="button" data-pay-planned="${item.id}"${isPlannedPaid(item) ? " disabled" : ""}>Оплачено</button>
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
      showToast("Плановая трата отключена");
    });
  });
  container.querySelectorAll("[data-pay-planned]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/planned-expenses/${button.dataset.payPlanned}/pay`, { method: "POST", body: { telegramUserId } });
      await loadDashboard();
      await loadHistory();
      showToast("Оплата записана");
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
        weeklyBudgetAmount: document.querySelector("#weeklyBudgetInput").value.trim(),
        baseCurrency: document.querySelector("#baseCurrencyInput").value,
        displayCurrency: document.querySelector("#displayCurrencyInput").value,
        usdThbRate: Number(document.querySelector("#usdThbRateInput").value)
      }
    }
  });
  await loadDashboard();
  showToast("Настройки сохранены");
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
  showToast("Расход сохранен");
}

async function savePlanned(event, plannedId) {
  event.preventDefault();
  const method = plannedId ? "PATCH" : "POST";
  const path = plannedId ? `/api/planned-expenses/${plannedId}` : "/api/planned-expenses";
  await api(path, { method, body: { telegramUserId, plannedExpense: collectPlanned() } });
  renderPlannedForm();
  document.querySelector("#plannedForm").classList.add("hidden");
  await loadDashboard();
  showToast(plannedId ? "Плановая трата сохранена" : "Плановая трата добавлена");
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

function parseDueDays(value) {
  return String(value ?? "")
    .split(",")
    .map((day) => Number(day.trim()))
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 31);
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
  if (item.recurrence === "weekly") {
    const weekday = today.getDay() === 0 ? 7 : today.getDay();
    return Number(item.weekday) === weekday;
  }
  const days = Array.isArray(item.due_days) && item.due_days.length ? item.due_days : [item.due_day];
  return days.map(Number).includes(today.getDate());
}

function isPlannedPaid(item) {
  return Number(item.paid_count ?? (item.paid_month ? 1 : 0)) > 0;
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

function recurrenceLabel(item) {
  const recurrence = typeof item === "string" ? item : item.recurrence;
  if (recurrence === "weekly") return `каждый ${weekdayName(item.weekday)}`;
  if (recurrence === "twice_monthly") {
    const days = Array.isArray(item.due_days) && item.due_days.length ? item.due_days : [item.due_day].filter(Boolean);
    return days.length ? `${days.join(" и ")} числа` : "2 раза в месяц";
  }
  if (recurrence === "monthly") return item.due_day ? `${item.due_day} числа` : "раз в месяц";
  if (recurrence === "one_off") return item.due_date ? formatDate(item.due_date) : "один раз";
  return recurrence;
}

function weekdayOptions(selected) {
  return [1, 2, 3, 4, 5, 6, 7]
    .map((weekday) => option(String(weekday), String(selected ?? 1), weekdayName(weekday)))
    .join("");
}

function weekdayName(weekday) {
  return {
    1: "понедельник",
    2: "вторник",
    3: "среду",
    4: "четверг",
    5: "пятницу",
    6: "субботу",
    7: "воскресенье"
  }[Number(weekday)] ?? "понедельник";
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

function moneyDisplaySigned(value, currency = "USD") {
  if (value == null || Number.isNaN(Number(value))) return "";
  const sign = Number(value) > 0 ? "+" : "";
  return `${sign}${moneyDisplay(value, currency)}`;
}

function setText(selector, text) {
  document.querySelector(selector).textContent = text;
}

function setProgress(selector, progress) {
  const bar = document.querySelector(selector);
  if (!bar) return;
  const percent = Math.max(0, Math.min(Number(progress?.percent ?? 0), 100));
  bar.style.width = `${percent}%`;
  bar.dataset.state = progress?.state ?? "good";
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

function formatDate(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDateOnly(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short"
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
