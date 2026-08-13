const EN_COMMANDS = [
  { command: "today", description: "📌 Today's spending" },
  { command: "week", description: "📆 This week's spending" },
  { command: "month", description: "📅 This month's spending" },
  { command: "budget", description: "💰 Budget status" },
  { command: "last", description: "✏️ Latest expense" },
  { command: "export", description: "📤 Export expenses" },
  { command: "feedback", description: "💬 Send feedback" },
  { command: "help", description: "❓ How to use Money Flow" }
];

const RU_COMMANDS = [
  { command: "today", description: "📌 Расходы сегодня" },
  { command: "week", description: "📆 Расходы за неделю" },
  { command: "month", description: "📅 Расходы за месяц" },
  { command: "budget", description: "💰 Состояние бюджета" },
  { command: "last", description: "✏️ Последний расход" },
  { command: "export", description: "📤 Экспорт расходов" },
  { command: "feedback", description: "💬 Обратная связь" },
  { command: "help", description: "❓ Как пользоваться" }
];

const START_COMMAND = {
  en: { command: "start", description: "Start Money Flow" },
  ru: { command: "start", description: "Начать работу с Money Flow" }
};

export function buildTelegramCommandMenu(language = "en", { onboarding = false } = {}) {
  const normalizedLanguage = language === "ru" ? "ru" : "en";
  const commands = normalizedLanguage === "ru" ? RU_COMMANDS : EN_COMMANDS;
  const menu = onboarding ? [START_COMMAND[normalizedLanguage], ...commands] : commands;
  return menu.map((command) => ({ ...command }));
}

export async function syncTelegramCommandMenu({ token, telegramClient = null, fetchImpl = fetch } = {}) {
  if (!token && !telegramClient) return { skipped: true };
  await setMyCommands({
    token,
    telegramClient,
    fetchImpl,
    commands: buildTelegramCommandMenu("en", { onboarding: true })
  });
  await setMyCommands({
    token,
    telegramClient,
    fetchImpl,
    commands: buildTelegramCommandMenu("ru", { onboarding: true }),
    languageCode: "ru"
  });
  await setChatMenuButton({ token, telegramClient, fetchImpl });
  return { ok: true };
}

export async function syncTelegramUserCommandMenu({
  token,
  telegramClient = null,
  fetchImpl = fetch,
  chatId,
  language = "en",
  onboardingStep = "completed"
} = {}) {
  if ((!token && !telegramClient) || chatId == null) return { skipped: true };
  const onboarding = onboardingStep !== "completed";
  await setMyCommands({
    token,
    telegramClient,
    fetchImpl,
    commands: buildTelegramCommandMenu(language, { onboarding }),
    scope: { type: "chat", chatId }
  });
  await setChatMenuButton({ token, telegramClient, fetchImpl, chatId });
  return { ok: true };
}

async function setMyCommands({ token, telegramClient, fetchImpl, commands, languageCode = null, scope = null }) {
  if (telegramClient?.setMyCommands) {
    const payload = { commands };
    if (languageCode) payload.languageCode = languageCode;
    if (scope) payload.scope = scope;
    return telegramClient.setMyCommands(payload);
  }

  const body = { commands };
  if (languageCode) body.language_code = languageCode;
  if (scope) body.scope = telegramCommandScopeBody(scope);
  return callTelegramApi({ token, fetchImpl, method: "setMyCommands", body });
}

async function setChatMenuButton({ token, telegramClient, fetchImpl, chatId = null }) {
  const menuButton = { type: "commands" };
  if (telegramClient?.setChatMenuButton) {
    const payload = { menuButton };
    if (chatId != null) payload.chatId = chatId;
    return telegramClient.setChatMenuButton(payload);
  }

  const body = { menu_button: menuButton };
  if (chatId != null) body.chat_id = chatId;
  return callTelegramApi({ token, fetchImpl, method: "setChatMenuButton", body });
}

function telegramCommandScopeBody(scope) {
  if (scope?.type === "chat") return { type: "chat", chat_id: scope.chatId };
  return scope;
}

async function callTelegramApi({ token, fetchImpl, method, body }) {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Telegram ${method} failed: ${response.status}`);
  return response.json();
}
