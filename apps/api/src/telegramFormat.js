import { categoryName } from "../../../packages/shared/src/categories.js";

export function formatDraft(expenses) {
  const lines = expenses.map((expense, index) =>
    `${index + 1}. <b>${escapeHtml(categoryName(expense.category_slug))}</b>\n   ${escapeHtml(expense.description)} · <b>${formatAmount(expense.amount)} ${expense.currency}</b>`
  );
  const total = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const review = expenses.some((expense) => expense.needs_review)
    ? "\n\n⚠️ Есть сомнительные строки, проверь перед сохранением."
    : "";
  return `🧾 <b>Я понял так:</b>\n\n${lines.join("\n\n")}\n\n<b>Итого:</b> ${formatAmount(total)} THB.${review}\n\nВсе верно?`;
}

export function formatSavedSummary(total, snapshot) {
  const progress = snapshot.budgetProgressPercent == null ? "" : ` (${formatAmount(snapshot.budgetProgressPercent)}%)`;
  const planDeviation = Number(snapshot.planDeviation ?? 0);
  const planLine = planDeviation > 0
    ? `⚠️ <b>План:</b> выше на ${formatAmount(Math.abs(planDeviation))} THB`
    : `🟢 <b>План:</b> ниже на ${formatAmount(Math.abs(planDeviation))} THB`;

  return [
    "✅ <b>Записал расход</b>",
    `<b>${formatAmount(total)} THB</b>`,
    "",
    "<b>Сейчас</b>",
    `📌 <b>Сегодня:</b> ${formatAmount(snapshot.today)} / ${formatAmount(snapshot.dayPlanLimit ?? snapshot.dailyPlanLimit)} THB`,
    `📆 <b>Неделя:</b> ${formatAmount(snapshot.week)} / ${formatAmount(snapshot.weekPlanLimit ?? snapshot.weeklyBudget)} THB`,
    "",
    "<b>Месяц</b>",
    `📅 <b>Потрачено:</b> ${formatAmount(snapshot.month)} / ${formatAmount(snapshot.monthlyBudget)} THB${progress}`,
    `🟢 <b>Свободно:</b> ${formatAmount(snapshot.freeRemaining)} THB`,
    `🧾 <b>Плановые:</b> ${formatAmount(snapshot.plannedRemaining)} THB`,
    `🔮 <b>Прогноз:</b> ${formatAmount(snapshot.forecastMonthTotal ?? 0)} THB`,
    planLine,
    "",
    `⚡️ <b>Можно тратить:</b> ${formatAmount(snapshot.safeToSpendPerDay)} THB/день`,
    "с учетом плановых трат до конца месяца"
  ].join("\n");
}

export function formatTotals(command, snapshot) {
  if (command === "/today") {
    return [
      `📌 <b>Сегодня:</b> ${formatAmount(snapshot.today)} THB`,
      `⚡️ <b>Можно тратить:</b> ${formatAmount(snapshot.safeToSpendPerDay)} THB/день`
    ].join("\n");
  }
  if (command === "/week") return `📆 <b>Неделя:</b> ${formatAmount(snapshot.week)} THB`;
  if (command === "/month") {
    const progress = snapshot.budgetProgressPercent == null ? "" : ` (${formatAmount(snapshot.budgetProgressPercent)}%)`;
    return [
      `📅 <b>Месяц:</b> ${formatAmount(snapshot.month)} / ${formatAmount(snapshot.monthlyBudget)} THB${progress}`,
      `🔮 <b>Прогноз:</b> ${formatAmount(snapshot.forecastMonthTotal ?? 0)} THB`
    ].join("\n");
  }
  return [
    `💰 <b>Бюджет:</b> ${formatAmount(snapshot.monthlyBudget)} THB`,
    `📅 <b>Месяц:</b> ${formatAmount(snapshot.month)} THB`,
    `🧾 <b>Плановые:</b> ${formatAmount(snapshot.plannedRemaining)} THB`,
    `🟢 <b>Свободно:</b> ${formatAmount(snapshot.freeRemaining)} THB`,
    `⚡️ <b>Можно тратить:</b> ${formatAmount(snapshot.safeToSpendPerDay)} THB/день`,
    `Статус: ${escapeHtml(statusLabel(snapshot.status))}`
  ].join("\n");
}

export function formatWeeklyReport(dashboard) {
  const snapshot = dashboard.snapshot;
  const top = (dashboard.topCategories ?? [])
    .slice(0, 3)
    .map((category, index) => `${index + 1}. ${escapeHtml(categoryName(category.category_slug))}: ${formatAmount(category.total)} THB`)
    .join("\n");
  return [
    "📊 <b>Еженедельный отчет</b>",
    "",
    `Неделя: <b>${formatAmount(snapshot.week)} THB</b>`,
    `Месяц: <b>${formatAmount(snapshot.month)} / ${formatAmount(snapshot.monthlyBudget)} THB</b>`,
    `Можно в день: <b>${formatAmount(snapshot.safeToSpendPerDay)} THB</b>`,
    `Прогноз месяца: <b>${formatAmount(snapshot.forecastMonthTotal ?? 0)} THB</b>`,
    "",
    top ? `<b>Топ категорий:</b>\n${top}` : "Топ категорий пока пуст."
  ].join("\n");
}

function statusLabel(status) {
  return {
    above_plan: "чуть быстрее плана",
    below_plan: "ниже плана",
    on_plan: "в плане"
  }[status] ?? status;
}

function formatAmount(value) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(Number(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
