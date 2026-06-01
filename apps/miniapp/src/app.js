const params = new URLSearchParams(window.location.search);
const telegramUserId = params.get("telegramUserId") || window.Telegram?.WebApp?.initDataUnsafe?.user?.id;

const money = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 2
});

const statusLabels = {
  above_plan: "чуть быстрее плана",
  below_plan: "ниже плана",
  on_plan: "в плане"
};

if (window.Telegram?.WebApp) {
  window.Telegram.WebApp.ready();
  window.Telegram.WebApp.expand();
}

loadDashboard().catch((error) => {
  document.querySelector("#latestExpenses").innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
});

async function loadDashboard() {
  if (!telegramUserId) {
    throw new Error("Нет Telegram user id. Откройте Mini App из бота.");
  }

  const response = await fetch(`/api/dashboard?telegramUserId=${encodeURIComponent(telegramUserId)}`);
  if (!response.ok) {
    throw new Error(response.status === 404 ? "Сначала отправьте /start боту." : "Не удалось загрузить dashboard.");
  }

  const data = await response.json();
  renderSnapshot(data.snapshot);
  renderLatest(data.latestExpenses);
}

function renderSnapshot(snapshot) {
  setText("#safeToSpend", `${money.format(snapshot.safeToSpendPerDay)} THB`);
  setText("#today", `${money.format(snapshot.today)} THB`);
  setText("#month", `${money.format(snapshot.month)} THB`);
  setText("#budget", `${money.format(snapshot.monthlyBudget)} THB`);
  setText("#remaining", `${money.format(snapshot.remaining)} THB`);

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
        <div class="expense-meta">${formatDate(expense.spent_at)} · ${escapeHtml(expense.category_slug)}</div>
      </div>
      <div class="expense-amount">${money.format(Number(expense.amount_original))} ${escapeHtml(expense.currency_original)}</div>
    </article>
  `).join("");
}

function setText(selector, text) {
  document.querySelector(selector).textContent = text;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
