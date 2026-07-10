const DEFAULT_COMMANDS = [
  { command: "start", description: "Start Money Flow" },
  { command: "feedback", description: "Send feedback to the developer" },
  { command: "today", description: "Show today's spending" },
  { command: "week", description: "Show this week's spending" },
  { command: "month", description: "Show this month's spending" },
  { command: "budget", description: "Show budget status" },
  { command: "app", description: "Open the Mini App" },
  { command: "settings", description: "Open settings" },
  { command: "export", description: "Export expenses to CSV" },
  { command: "delete_me", description: "Delete my data" }
];

const RU_COMMANDS = [
  { command: "start", description: "Запустить Money Flow" },
  { command: "feedback", description: "Отправить feedback разработчику" },
  { command: "today", description: "Показать расходы за сегодня" },
  { command: "week", description: "Показать расходы за неделю" },
  { command: "month", description: "Показать расходы за месяц" },
  { command: "budget", description: "Показать состояние бюджета" },
  { command: "app", description: "Открыть Mini App" },
  { command: "settings", description: "Открыть настройки" },
  { command: "export", description: "Экспортировать расходы в CSV" },
  { command: "delete_me", description: "\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u043c\u043e\u0438 \u0434\u0430\u043d\u043d\u044b\u0435" }
];

export function buildTelegramCommandMenu(language = "en") {
  return (language === "ru" ? RU_COMMANDS : DEFAULT_COMMANDS).map((command) => ({ ...command }));
}

export async function syncTelegramCommandMenu({ token, telegramClient = null, fetchImpl = fetch } = {}) {
  if (!token && !telegramClient) return { skipped: true };
  await setMyCommands({ token, telegramClient, fetchImpl, commands: buildTelegramCommandMenu() });
  await setMyCommands({ token, telegramClient, fetchImpl, commands: buildTelegramCommandMenu("ru"), languageCode: "ru" });
  return { ok: true };
}

async function setMyCommands({ token, telegramClient, fetchImpl, commands, languageCode = null }) {
  if (telegramClient?.setMyCommands) {
    const payload = languageCode ? { commands, languageCode } : { commands };
    return telegramClient.setMyCommands(payload);
  }

  const body = languageCode ? { commands, language_code: languageCode } : { commands };
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Telegram setMyCommands failed: ${response.status}`);
  return response.json();
}
