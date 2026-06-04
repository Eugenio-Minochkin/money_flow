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
  const language = user.interface_language ?? "en";

  const text = await messageText({ message, voiceTranscriber });
  if (!text) return sendMessage(token, message.chat.id, botText(language, "unsupported"));

  if (text === "/start") {
    return sendMessage(token, message.chat.id, botText(language, "start"), appKeyboard(miniAppUrl, from.id));
  }

  if (text === "/today" || text === "/week" || text === "/month" || text === "/budget") {
    const dashboard = await repository.dashboard(from.id);
    return sendMessage(token, message.chat.id, formatTotals(text, dashboard.snapshot, { language }), appKeyboard(miniAppUrl, from.id));
  }

  if (text === "/app" || text === "/settings") {
    return sendMessage(token, message.chat.id, botText(language, "openMiniApp"), appKeyboard(miniAppUrl, from.id));
  }

  const parsed = await expenseParser.parse(text, { defaultCurrency: user.base_currency ?? "THB" });
  if (parsed.expenses.length === 0) {
    return sendMessage(token, message.chat.id, botText(language, "amountNotFound"));
  }

  const draft = await repository.createDraft(user.id, text, parsed.expenses);
  return sendMessage(token, message.chat.id, formatDraft(parsed.expenses, { language, baseCurrency: user.base_currency ?? "THB" }), draftKeyboard(draft.id, parsed.expenses, miniAppUrl, from.id));
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
  const user = await repository.getUserByTelegramId?.(telegramUserId);
  const language = user?.interface_language ?? "en";

  if (action === "cat") {
    const draft = await repository.getDraftForTelegramUser(draftId, telegramUserId);
    const items = updateDraftItem(draft, Number(itemIndex), { category_slug: value, needs_review: false, confidence: 0.9 });
    const updated = await repository.updateDraftItems(draftId, telegramUserId, items);
    await answerCallback(token, callback.id, botText(language, "categoryUpdatedCallback"));
    return sendMessage(token, callback.message.chat.id, formatDraft(updated.items, { language, baseCurrency: user?.base_currency ?? "THB" }), draftKeyboard(updated.id, updated.items, miniAppUrl, telegramUserId));
  }

  if (action === "amount") {
    const draft = await repository.getDraftForTelegramUser(draftId, telegramUserId);
    const current = draft.items[Number(itemIndex)];
    const amount = Math.max(Number(current.amount) + Number(value), 1);
    const items = updateDraftItem(draft, Number(itemIndex), { amount });
    const updated = await repository.updateDraftItems(draftId, telegramUserId, items);
    await answerCallback(token, callback.id, botText(language, "amountUpdatedCallback"));
    return sendMessage(token, callback.message.chat.id, formatDraft(updated.items, { language, baseCurrency: user?.base_currency ?? "THB" }), draftKeyboard(updated.id, updated.items, miniAppUrl, telegramUserId));
  }

  if (action === "confirm") {
    const expenses = await repository.confirmDraft(draftId, telegramUserId);
    const dashboard = await repository.dashboard(telegramUserId);
    const total = expenses.reduce((sum, expense) => sum + Number(expense.amount_base), 0);
    await answerCallback(token, callback.id, botText(language, "savedCallback"));
    return sendMessage(token, callback.message.chat.id, formatSavedSummary(total, dashboard.snapshot, { language }), appKeyboard(miniAppUrl, telegramUserId));
  }

  if (action === "cancel") {
    await repository.cancelDraft(draftId, telegramUserId);
    await answerCallback(token, callback.id, botText(language, "cancelledCallback"));
    return sendMessage(token, callback.message.chat.id, botText(language, "draftCancelled"));
  }

  if (action === "inbox") {
    await repository.moveDraftToInbox(draftId, telegramUserId);
    await answerCallback(token, callback.id, botText(language, "movedCallback"));
    return sendMessage(token, callback.message.chat.id, botText(language, "movedToInbox"));
  }

  await answerCallback(token, callback.id, botText(language, "openMiniAppCallback"));
  return sendMessage(token, callback.message.chat.id, botText(language, "editInMiniApp"), appKeyboard(miniAppUrl, telegramUserId));
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
      formatWeeklyReport(dashboard, { language: user.interface_language ?? "en" }),
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

function botText(language, key) {
  const lang = language === "ru" ? "ru" : "en";
  const messages = {
    ru: {
      amountNotFound: "Не нашел сумму. Напиши так: <b>кофе 70 бат</b>.",
      amountUpdatedCallback: "Сумма обновлена",
      cancelledCallback: "Отменено",
      categoryUpdatedCallback: "Категория обновлена",
      draftCancelled: "Черновик отменен.",
      editInMiniApp: "Редактирование доступно в Mini App.",
      movedCallback: "Перенесено",
      movedToInbox: "Перенес в Inbox. Можно разобрать позже в Mini App.",
      openMiniApp: "Открыть Mini App:",
      openMiniAppCallback: "Открой Mini App для изменения",
      savedCallback: "Сохранено",
      start: [
        "Привет. Я помогу быстро вести расходы.",
        "",
        "Напиши или надиктуй, например:",
        "<b>кофе 70 бат и обед 180</b>",
        "",
        "Сначала покажу черновик, сохраню только после подтверждения."
      ].join("\n"),
      unsupported: "Пока умею принимать только текстовые и голосовые расходы."
    },
    en: {
      amountNotFound: "I did not find an amount. Try: <b>coffee 70 baht</b>.",
      amountUpdatedCallback: "Amount updated",
      cancelledCallback: "Cancelled",
      categoryUpdatedCallback: "Category updated",
      draftCancelled: "Draft cancelled.",
      editInMiniApp: "Editing is available in Mini App.",
      movedCallback: "Moved",
      movedToInbox: "Moved to Inbox. You can review it later in Mini App.",
      openMiniApp: "Open Mini App:",
      openMiniAppCallback: "Open Mini App to edit",
      savedCallback: "Saved",
      start: [
        "Hi. I will help you track expenses quickly.",
        "",
        "Write or dictate, for example:",
        "<b>coffee 70 baht and lunch 180</b>",
        "",
        "I will show a draft first and save only after confirmation."
      ].join("\n"),
      unsupported: "For now I can accept only text and voice expenses."
    }
  };
  return messages[lang][key];
}
