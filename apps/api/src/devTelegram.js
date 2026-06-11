export const DEMO_TELEGRAM_USER_ID = 100001;

export function createCapturedTelegramClient() {
  const messages = [];
  const callbackAnswers = [];
  return {
    messages,
    callbackAnswers,
    async sendMessage({ chatId, text, replyMarkup }) {
      const message = { method: "sendMessage", chatId, text, replyMarkup };
      messages.push(message);
      return { ok: true, result: message };
    },
    async answerCallbackQuery({ callbackQueryId, text }) {
      const answer = { method: "answerCallbackQuery", callbackQueryId, text };
      callbackAnswers.push(answer);
      return { ok: true, result: answer };
    }
  };
}

export function buildFakeMessageUpdate({ telegramUserId = DEMO_TELEGRAM_USER_ID, text, messageId = Date.now() }) {
  return {
    update_id: Number(messageId),
    message: {
      message_id: Number(messageId),
      date: Math.floor(Date.now() / 1000),
      chat: { id: telegramUserId, type: "private" },
      from: {
        id: telegramUserId,
        is_bot: false,
        first_name: "Acceptance",
        username: "moneyflow_demo"
      },
      text: String(text ?? "")
    }
  };
}

export function buildFakeCallbackUpdate({ telegramUserId = DEMO_TELEGRAM_USER_ID, data, callbackId = `dev-${Date.now()}` }) {
  return {
    update_id: Date.now(),
    callback_query: {
      id: callbackId,
      from: {
        id: telegramUserId,
        is_bot: false,
        first_name: "Acceptance",
        username: "moneyflow_demo"
      },
      message: {
        message_id: Date.now(),
        chat: { id: telegramUserId, type: "private" },
        date: Math.floor(Date.now() / 1000)
      },
      data: String(data ?? "")
    }
  };
}

export async function processDevTelegramUpdate({ createBot, payload }) {
  const telegramClient = createCapturedTelegramClient();
  const bot = createBot(telegramClient);
  const update = payload.type === "callback" || payload.callbackData
    ? buildFakeCallbackUpdate({
        telegramUserId: payload.telegramUserId,
        data: payload.callbackData ?? payload.data
      })
    : buildFakeMessageUpdate({
        telegramUserId: payload.telegramUserId,
        text: payload.text
      });
  await bot.handleUpdate(update);
  return {
    update,
    messages: telegramClient.messages,
    callbackAnswers: telegramClient.callbackAnswers
  };
}
