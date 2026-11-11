import { categoryLabel } from "../../../packages/shared/src/categories.js";
import { expenseCategoryKeyboard } from "./telegramExpenseEditor.js";
import { formatMoney } from "./telegramFormat.js";

export function buildSavedExpenseReceipt({ expense, snapshot, language, confirmDelete = false }) {
  if (!Number.isSafeInteger(Number(expense?.id)) || Number(expense.id) <= 0 || !snapshot) return null;
  const en = language === "en";
  const currency = snapshot.baseCurrency ?? expense.currency_original ?? "THB";
  const money = (value, code = currency) => formatMoney(value, code, language);
  const category = categoryLabel(expense.category_slug, language);
  const { inline_keyboard: categoryRows } = expenseCategoryKeyboard(
    { type: "expense", id: expense.id, expense },
    undefined,
    { language, quickCategory: true }
  );
  const categoryChoices = categoryRows.slice(0, -1).map(([choice]) => paragraph({
    type: "button",
    button: { ...choice, style: "link" }
  }));
  const key = `ee:x:${expense.id}`;
  const editValue = (label, field) => paragraph([bold(label), "  ", {
    type: "button",
    button: { text: "✎", callback_data: `${key}:f:${field}`, style: "link" }
  }]);
  const blocks = [
    paragraph(bold(en ? "✅ Saved" : "✅ Записал")),
    editValue(expense.description || (en ? "Expense" : "Трата"), "d"),
    editValue(money(expense.amount_original ?? expense.amount_base, expense.currency_original ?? currency), "a"),
    { type: "details", summary: [en ? "Category  ·  " : "Категория  ·  ", bold(category)], blocks: categoryChoices }
  ];
  blocks.push(paragraph([
    bold(en ? "Today · regular" : "Сегодня · обычные"), "  ", money(snapshot.today), " / ", money(snapshot.dayPlanLimit),
    "\n", progressLine(snapshot.dayProgressPercent, snapshot.dayPlanLimit),
    ...(Number(snapshot.dayOverrun) > 0
      ? [en ? "Over by " : "Сверх лимита ", bold(money(snapshot.dayOverrun))]
      : [en ? "Left " : "Осталось ", bold(money(snapshot.dayRemaining))])
  ]));
  const plannedToday = snapshot.plannedToday ?? snapshot.plannedTodayTotal;
  const largeToday = snapshot.largeToday ?? snapshot.largeTodayTotal;
  if (Number(plannedToday) > 0) blocks.push(paragraph([en ? "Planned today  " : "Плановые сегодня  ", money(plannedToday)]));
  if (Number(largeToday) > 0) blocks.push(paragraph([en ? "Large expenses today  " : "Крупные сегодня  ", money(largeToday)]));
  if (Number(plannedToday) > 0 || Number(largeToday) > 0) {
    const totalToday = Number(snapshot.today ?? 0) + Number(plannedToday ?? 0) + Number(largeToday ?? 0);
    blocks.push(paragraph([en ? "Total today  " : "Всего за день  ", bold(money(totalToday))]));
  }

  blocks.push(paragraph([
    bold(en ? "Month" : "Месяц"), "  ", money(snapshot.month), " / ", money(snapshot.monthlyBudget),
    "\n", progressLine(snapshot.budgetProgressPercent, snapshot.monthlyBudget),
    en ? "Free after planned " : "Свободно после плановых ", bold(money(snapshot.freeRemaining))
  ]));
  const forecast = snapshot.forecastMonthTotal;
  const hasForecast = Number.isFinite(forecast) && snapshot.monthlyBudget > 0;
  if (Number(snapshot.plannedRemaining) > 0) {
    blocks.push(paragraph([en ? "Reserved for planned payments  " : "В резерве на плановые  ", money(snapshot.plannedRemaining)]));
  }
  if (hasForecast) {
    const difference = Math.round((forecast - snapshot.monthlyBudget) * 100) / 100;
    const comparison = difference === 0 ? (en ? "On budget" : "Ровно по бюджету")
      : `${money(Math.abs(difference))} ${difference > 0 ? (en ? "above budget" : "выше бюджета") : (en ? "below budget" : "ниже бюджета")}`;
    blocks.push({
      type: "details",
      summary: [en ? "Month-end forecast  ·  " : "Прогноз на конец месяца  ·  ", bold(money(forecast))],
      blocks: [paragraph(comparison), paragraph(en
        ? "At the current pace, including planned payments"
        : "При текущем темпе, с учётом плановых платежей")]
    });
  }
  if (confirmDelete) blocks.push({
    type: "pullquote",
    text: [
      bold(en ? "Delete this expense?" : "Удалить эту трату?"),
      en ? "\nIt will no longer count toward the budget." : "\nТрата перестанет учитываться в бюджете."
    ]
  });
  blocks.push({
    type: "buttons",
    align: "center",
    buttons: confirmDelete ? [
      { text: en ? "Keep" : "Оставить", callback_data: `${key}:r:back` },
      { text: en ? "Delete" : "Удалить", callback_data: `${key}:r:delok`, style: "danger" }
    ] : [{ text: en ? "🗑 Delete expense" : "🗑 Удалить трату", callback_data: `${key}:r:del`, style: "danger" }]
  });
  return { blocks, skip_entity_detection: true };
}

function paragraph(text) {
  return { type: "paragraph", text };
}

function bold(text) {
  return { type: "bold", text };
}

function progressLine(percent, limit) {
  if (!(limit > 0) || !Number.isFinite(percent)) return "";
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return "▰".repeat(filled) + "▱".repeat(10 - filled) + "  ";
}
