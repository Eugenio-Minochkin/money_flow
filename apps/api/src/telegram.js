import { createExpenseParser } from "./expenseParser.js";
import { formatDraft, formatSavedSummary, formatTotals, formatWeeklyReport } from "./telegramFormat.js";
import { appKeyboard, draftKeyboard } from "./telegramKeyboards.js";

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
