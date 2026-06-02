import { categoryName } from "../../../packages/shared/src/categories.js";
import { createExpenseParser } from "./expenseParser.js";

export function createTelegramBot({
  repository,
  token,
  miniAppUrl,
  expenseParser = createExpenseParser(),
  voiceTranscriber
}) {
  return {
    async handleUpdate(update) {
      if (update.message) {
        return handleMessage({ update, repository, token, miniAppUrl, expenseParser, voiceTranscriber });
      }
      if (update.callback_query) return handleCallback({ update, repository, token, miniAppUrl });
      return { ok: true };
    }
  };
}

async function handleMessage({ update, repository, token, miniAppUrl, expenseParser, voiceTranscriber }) {
  const message = update.message;
  const from = message.from;
  if (!from) return { ok: true };

  const user = await repository.upsertTelegramUser({
    id: from.id,
    firstName: from.first_name,
    username: from.username
  });

  const text = await messageText({ message, voiceTranscriber });
  if (!text) {
    return sendMessage(token, message.chat.id, "Пока умею принимать только текстовые и голосовые расходы.");
  }

  if (text === "/start") {
    return sendMessage(
      token,
      message.chat.id,
      [
        "Привет. Я помогу быстро вести расходы.",
        "",
        "Напиши или надиктуй, например:",
        "<b>кофе 70 бат и обед 180</b>",
        "",
        "Сначала покажу черновик, сохраню только после подтверждения."
      ].join("\n"),
      appKeyboard(miniAppUrl, from.id)
    );
  }

  if (text === "/today" || text === "/week" || text === "/month" || text === "/budget") {
    const dashboard = await repository.dashboard(from.id);
    return sendMessage(token, message.chat.id, formatTotals(text, dashboard.snapshot), appKeyboard(miniAppUrl, from.id));
  }

  if (text === "/app" || text === "/settings") {
    return sendMessage(token, message.chat.id, "Открыть Mini App:", appKeyboard(miniAppUrl, from.id));
  }

  const parsed = await expenseParser.parse(text);
  if (parsed.expenses.length === 0) {
    return sendMessage(token, message.chat.id, "Не нашел сумму. Напиши так: <b>кофе 70 бат</b>.");
  }

  const draft = await repository.createDraft(user.id, text, parsed.expenses);
  return sendMessage(token, message.chat.id, formatDraft(parsed.expenses), draftKeyboard(draft.id, parsed.expenses, miniAppUrl, from.id));
}

async function messageText({ message, voiceTranscriber }) {
  if (message.text?.trim()) return message.text.trim();
  if (!message.voice) return null;
  if (!voiceTranscriber?.isConfigured()) return null;

  try {
    return await voiceTranscriber.transcribeTelegramVoice(message.voice);
  } catch (error) {
    console.error("[telegram] voice transcription failed", error.message);
    return null;
  }
}

async function handleCallback({ update, repository, token, miniAppUrl }) {
  const callback = update.callback_query;
  const [action, draftId, itemIndex, value] = callback.data.split(":");
  const telegramUserId = callback.from.id;

  if (action === "cat") {
    const draft = await repository.getDraftForTelegramUser(draftId, telegramUserId);
    const items = updateDraftItem(draft, Number(itemIndex), { category_slug: value, needs_review: false, confidence: 0.9 });
    const updated = await repository.updateDraftItems(draftId, telegramUserId, items);
    await answerCallback(token, callback.id, "Категория обновлена");
    return sendMessage(token, callback.message.chat.id, formatDraft(updated.items), draftKeyboard(updated.id, updated.items, miniAppUrl, telegramUserId));
  }

  if (action === "amount") {
    const draft = await repository.getDraftForTelegramUser(draftId, telegramUserId);
    const current = draft.items[Number(itemIndex)];
    const amount = Math.max(Number(current.amount) + Number(value), 1);
    const items = updateDraftItem(draft, Number(itemIndex), { amount });
    const updated = await repository.updateDraftItems(draftId, telegramUserId, items);
    await answerCallback(token, callback.id, "Сумма обновлена");
    return sendMessage(token, callback.message.chat.id, formatDraft(updated.items), draftKeyboard(updated.id, updated.items, miniAppUrl, telegramUserId));
  }

  if (action === "confirm") {
    const expenses = await repository.confirmDraft(draftId, telegramUserId);
    const dashboard = await repository.dashboard(telegramUserId);
    const total = expenses.reduce((sum, expense) => sum + Number(expense.amount_base), 0);
    await answerCallback(token, callback.id, "Сохранено");
    return sendMessage(
      token,
      callback.message.chat.id,
      formatSavedSummary(total, dashboard.snapshot),
      appKeyboard(miniAppUrl, telegramUserId)
    );
  }

  if (action === "cancel") {
    await repository.cancelDraft(draftId, telegramUserId);
    await answerCallback(token, callback.id, "Отменено");
    return sendMessage(token, callback.message.chat.id, "Черновик отменен.");
  }

  if (action === "inbox") {
    await repository.moveDraftToInbox(draftId, telegramUserId);
    await answerCallback(token, callback.id, "Перенесено");
    return sendMessage(token, callback.message.chat.id, "Перенес в Inbox. Можно разобрать позже в Mini App.");
  }

  await answerCallback(token, callback.id, "Открой Mini App для изменения");
  return sendMessage(token, callback.message.chat.id, "Редактирование доступно в Mini App.", appKeyboard(miniAppUrl, telegramUserId));
}

function updateDraftItem(draft, index, patch) {
  if (!draft?.items?.[index]) throw new Error("Draft item not found");
  return draft.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item);
}

function formatDraft(expenses) {
  const lines = expenses.map((expense, index) =>
    `${index + 1}. <b>${escapeHtml(categoryName(expense.category_slug))}</b>\n   ${escapeHtml(expense.description)} · <b>${formatAmount(expense.amount)} ${expense.currency}</b>`
  );
  const total = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const review = expenses.some((expense) => expense.needs_review)
    ? "\n\n⚠️ Есть сомнительные строки, проверь перед сохранением."
    : "";
  return `🧾 <b>Я понял так:</b>\n\n${lines.join("\n\n")}\n\n<b>Итого:</b> ${formatAmount(total)} THB.${review}\n\nВсе верно?`;
}

function formatSavedSummary(total, snapshot) {
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
    `📌 <b>Сегодня:</b> ${formatAmount(snapshot.today)} THB`,
    `📆 <b>Неделя:</b> ${formatAmount(snapshot.week)} THB`,
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

function formatTotals(command, snapshot) {
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

function draftKeyboard(draftId, items = [], miniAppUrl, telegramUserId) {
  const firstReviewIndex = items.findIndex((item) => item.needs_review || item.category_slug === "other");
  const quickRows = [
    [
      { text: "-10", callback_data: `amount:${draftId}:0:-10` },
      { text: "+10", callback_data: `amount:${draftId}:0:10` }
    ]
  ];
  if (firstReviewIndex >= 0) {
    quickRows.push([
      { text: "Еда", callback_data: `cat:${draftId}:${firstReviewIndex}:food_cafe` },
      { text: "Дом", callback_data: `cat:${draftId}:${firstReviewIndex}:home` },
      { text: "Здоровье", callback_data: `cat:${draftId}:${firstReviewIndex}:health` }
    ]);
  }
  return {
    inline_keyboard: [
      [{ text: "✅ Подтвердить", callback_data: `confirm:${draftId}` }],
      ...quickRows,
      [
        { text: "✏️ Изменить", web_app: { url: `${miniAppUrl}?telegramUserId=${telegramUserId}&draftId=${draftId}` } },
        { text: "🗑 Отменить", callback_data: `cancel:${draftId}` }
      ],
      [{ text: "📥 Разобрать позже", callback_data: `inbox:${draftId}` }],
      [{ text: "📱 Mini App", web_app: { url: `${miniAppUrl}?telegramUserId=${telegramUserId}` } }]
    ]
  };
}

function appKeyboard(miniAppUrl, telegramUserId) {
  return {
    inline_keyboard: [[{ text: "📱 Открыть Mini App", web_app: { url: `${miniAppUrl}?telegramUserId=${telegramUserId}` } }]]
  };
}

export async function sendWeeklyReports({ repository, token, miniAppUrl, now = new Date() }) {
  const reportKey = localDateKey(now);
  const users = await repository.listUsersPendingWeeklyReport(reportKey);
  for (const user of users) {
    const dashboard = await repository.dashboard(Number(user.telegram_user_id), now);
    if (!dashboard) continue;
    await sendMessage(
      token,
      Number(user.telegram_user_id),
      formatWeeklyReport(dashboard),
      appKeyboard(miniAppUrl, Number(user.telegram_user_id))
    );
    await repository.markWeeklyReportSent(user.id, reportKey);
  }
}

export function shouldSendWeeklyReport(now = new Date()) {
  const local = new Date(now.getTime() + 7 * 60 * 60_000);
  const weekday = local.getUTCDay();
  const hour = local.getUTCHours();
  return weekday === 0 && hour >= 20;
}

function formatWeeklyReport(dashboard) {
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

function localDateKey(now) {
  const local = new Date(now.getTime() + 7 * 60 * 60_000);
  return local.toISOString().slice(0, 10);
}

async function sendMessage(token, chatId, text, replyMarkup) {
  if (!token) {
    console.log("[telegram:sendMessage]", { chatId, text, replyMarkup });
    return { ok: true };
  }
  return telegramRequest(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: replyMarkup
  });
}

async function answerCallback(token, callbackQueryId, text) {
  if (!token) return { ok: true };
  return telegramRequest(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text
  });
}

async function telegramRequest(token, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Telegram ${method} failed: ${response.status}`);
  return response.json();
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
