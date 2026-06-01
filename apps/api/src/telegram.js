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

  if (text === "/today" || text === "/month" || text === "/budget") {
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
  return sendMessage(token, message.chat.id, formatDraft(parsed.expenses), draftKeyboard(draft.id, miniAppUrl, from.id));
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
  const [action, draftId] = callback.data.split(":");
  const telegramUserId = callback.from.id;

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

function formatDraft(expenses) {
  const lines = expenses.map((expense, index) =>
    `${index + 1}. <b>${escapeHtml(categoryName(expense.category_slug))}</b>\n   ${escapeHtml(expense.description)} — <b>${formatAmount(expense.amount)} ${expense.currency}</b>`
  );
  const total = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const review = expenses.some((expense) => expense.needs_review)
    ? "\n\n⚠️ Есть сомнительные строки, проверь перед сохранением."
    : "";
  return `🧾 <b>Я понял так:</b>\n\n${lines.join("\n\n")}\n\n<b>Итого:</b> ${formatAmount(total)} THB.${review}\n\nПодтвердить?`;
}

function formatSavedSummary(total, snapshot) {
  return [
    `✅ <b>Записал:</b> ${formatAmount(total)} THB`,
    "",
    `📌 <b>Сегодня:</b> ${formatAmount(snapshot.today)} THB`,
    `📆 <b>Неделя:</b> ${formatAmount(snapshot.week)} THB`,
    `📅 <b>Месяц:</b> ${formatAmount(snapshot.month)} / ${formatAmount(snapshot.monthlyBudget)} THB`,
    `🧾 <b>Плановые:</b> ${formatAmount(snapshot.plannedRemaining)} THB`,
    `⚡️ <b>Можно в день:</b> ${formatAmount(snapshot.safeToSpendPerDay)} THB`
  ].join("\n");
}

function formatTotals(command, snapshot) {
  if (command === "/today") return `📌 <b>Сегодня:</b> ${formatAmount(snapshot.today)} THB`;
  if (command === "/month") {
    return `📅 <b>Месяц:</b> ${formatAmount(snapshot.month)} / ${formatAmount(snapshot.monthlyBudget)} THB`;
  }
  return [
    `💰 <b>Бюджет:</b> ${formatAmount(snapshot.monthlyBudget)} THB`,
    `📅 <b>Месяц:</b> ${formatAmount(snapshot.month)} THB`,
    `🧾 <b>Плановые:</b> ${formatAmount(snapshot.plannedRemaining)} THB`,
    `🟢 <b>Свободно:</b> ${formatAmount(snapshot.freeRemaining)} THB`,
    `⚡️ <b>Можно в день:</b> ${formatAmount(snapshot.safeToSpendPerDay)} THB`,
    `Статус: ${escapeHtml(statusLabel(snapshot.status))}`
  ].join("\n");
}

function draftKeyboard(draftId, miniAppUrl, telegramUserId) {
  return {
    inline_keyboard: [
      [{ text: "Confirm all", callback_data: `confirm:${draftId}` }],
      [
        { text: "Edit", web_app: { url: `${miniAppUrl}?telegramUserId=${telegramUserId}&draftId=${draftId}` } },
        { text: "Cancel", callback_data: `cancel:${draftId}` }
      ],
      [{ text: "Move to Inbox", callback_data: `inbox:${draftId}` }],
      [{ text: "Open in Mini App", web_app: { url: `${miniAppUrl}?telegramUserId=${telegramUserId}` } }]
    ]
  };
}

function appKeyboard(miniAppUrl, telegramUserId) {
  return {
    inline_keyboard: [[{ text: "Open Mini App", web_app: { url: `${miniAppUrl}?telegramUserId=${telegramUserId}` } }]]
  };
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
