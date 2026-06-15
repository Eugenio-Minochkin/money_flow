import { createExpenseParser } from "./expenseParser.js";
import { parseExpenseText } from "../../../packages/shared/src/parser.js";
import { parsePlannedExpenseText } from "../../../packages/shared/src/plannedParser.js";
import { normalizeCurrency, SUPPORTED_CURRENCY_CODES } from "../../../packages/shared/src/currencies.js";
import { formatDraft, formatPlannedDraft, formatSavedSummary, formatTotals, formatWeeklyReport } from "./telegramFormat.js";
import { appKeyboard, draftKeyboard, inboxDraftKeyboard, plannedDraftKeyboard } from "./telegramKeyboards.js";

const ONBOARDING_STEPS = ["language", "budget_setup", "base_currency", "monthly_budget", "current_month_budget", "month_opening_spend"];

export function createTelegramBot({
  repository,
  token,
  miniAppUrl,
  expenseParser = createExpenseParser(),
  voiceTranscriber,
  telegramClient,
  now = () => new Date()
}) {
  return {
    async handleUpdate(update) {
      if (update.message) {
        return handleMessage({ update, repository, token, miniAppUrl, expenseParser, voiceTranscriber, telegramClient, now });
      }
      if (update.callback_query) return handleCallback({ update, repository, token, miniAppUrl, telegramClient });
      return { ok: true };
    }
  };
}

async function handleMessage({ update, repository, token, miniAppUrl, expenseParser, voiceTranscriber, telegramClient, now }) {
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
  if (!text) return sendMessage(token, message.chat.id, botText(language, "unsupported"), null, telegramClient);

  if (text === "/start") {
    if (isOnboardingActive(user)) {
      return sendMessage(token, message.chat.id, onboardingPrompt(user), onboardingReplyMarkup(user), telegramClient);
    }
    return sendMessage(token, message.chat.id, botText(language, "start"), appKeyboard(miniAppUrl, from.id, language), telegramClient);
  }

  if (text === "/today" || text === "/week" || text === "/month" || text === "/budget") {
    const dashboard = await repository.dashboard(from.id);
    return sendMessage(token, message.chat.id, formatTotals(text, dashboard.snapshot, { language }), appKeyboard(miniAppUrl, from.id, language), telegramClient);
  }

  if (text === "/app" || text === "/settings") {
    return sendMessage(token, message.chat.id, botText(language, "openMiniApp"), appKeyboard(miniAppUrl, from.id, language), telegramClient);
  }

  if (isOnboardingActive(user)) {
    return handleOnboardingMessage({ text, user, repository, token, chatId: message.chat.id, miniAppUrl, telegramUserId: from.id, telegramClient, now });
  }

  const planned = parsePlannedExpenseText(text, { defaultCurrency: user.base_currency ?? "THB" });
  if (planned) {
    const draft = await repository.createPlannedDraft(user.id, text, planned);
    return sendMessage(
      token,
      message.chat.id,
      formatPlannedDraft(planned, { language }),
      plannedDraftKeyboard(draft.id, miniAppUrl, from.id, language),
      telegramClient
    );
  }

  const parsed = await expenseParser.parse(text, { defaultCurrency: user.base_currency ?? "THB" });
  if (parsed.expenses.length === 0) {
    return sendMessage(token, message.chat.id, botText(language, "amountNotFound"), null, telegramClient);
  }

  const draft = await repository.createDraft(user.id, text, parsed.expenses);
  return sendMessage(token, message.chat.id, formatDraft(parsed.expenses, { language, baseCurrency: user.base_currency ?? "THB" }), draftKeyboard(draft.id, parsed.expenses, miniAppUrl, from.id, language), telegramClient);
}

async function messageText({ message, voiceTranscriber }) {
  if (message.text?.trim()) return message.text.trim();
  const audio = message.voice ?? message.audio;
  if (!audio) return null;
  if (!voiceTranscriber?.isConfigured()) return null;

  try {
    return await voiceTranscriber.transcribeTelegramVoice(audio);
  } catch (error) {
    console.error("[telegram] voice transcription failed", error.message);
    return null;
  }
}

async function handleOnboardingMessage({ text, user, repository, token, chatId, miniAppUrl, telegramUserId, telegramClient, now }) {
  const language = user.interface_language ?? "en";
  const step = user.onboarding_step ?? "completed";

  if (step === "language") {
    const selectedLanguage = parseLanguage(text);
    if (!selectedLanguage) {
      return sendMessage(token, chatId, onboardingText(language, "languageRetry"), languageKeyboard(), telegramClient);
    }
    await updateOnboardingLanguage(repository, telegramUserId, selectedLanguage);
    return sendMessage(token, chatId, onboardingText(selectedLanguage, "introBudgetSetup"), null, telegramClient);
  }

  if (step === "budget_setup") {
    return handleBudgetSetupMessage({ text, user, repository, token, chatId, miniAppUrl, telegramUserId, telegramClient, now });
  }

  if (step === "base_currency") {
    const currency = parseCurrency(text);
    if (!currency) {
      return sendMessage(token, chatId, onboardingText(language, "baseCurrencyRetry"), null, telegramClient);
    }
    if (repository.updateOnboardingBaseCurrency) {
      await repository.updateOnboardingBaseCurrency(telegramUserId, currency);
    } else {
      await repository.updateUserSettings(telegramUserId, {
        monthlyBudgetAmount: user.monthly_budget_amount ?? 45000,
        baseCurrency: currency,
        displayCurrency: user.display_currency ?? "USD",
        usdThbRate: user.usd_thb_rate ?? 32.65,
        weeklyBudgetAmount: user.weekly_budget_amount ?? null,
        interfaceLanguage: language,
        onboardingStep: "monthly_budget"
      });
    }
    return sendMessage(token, chatId, onboardingText(language, "monthlyBudget", { currency }), null, telegramClient);
  }

  if (step === "monthly_budget") {
    const amount = parseSingleAmount(text, user.base_currency ?? "THB");
    if (!amount || amount.amount <= 0) {
      return sendMessage(token, chatId, onboardingText(language, "monthlyBudgetRetry", { currency: user.base_currency ?? "THB" }), null, telegramClient);
    }
    const nextStep = localMonthDay(now()) > 5 ? "current_month_budget" : "completed";
    if (repository.updateOnboardingMonthlyBudget) {
      await repository.updateOnboardingMonthlyBudget(telegramUserId, amount.amount, nextStep);
    } else {
      await repository.updateUserSettings(telegramUserId, {
        monthlyBudgetAmount: amount.amount,
        baseCurrency: user.base_currency ?? "THB",
        displayCurrency: user.display_currency ?? "USD",
        usdThbRate: user.usd_thb_rate ?? 32.65,
        weeklyBudgetAmount: user.weekly_budget_amount ?? null,
        interfaceLanguage: language,
        onboardingStep: nextStep
      });
    }
    if (nextStep === "completed") {
      await repository.setOnboardingStep?.(telegramUserId, "completed");
      return sendMessage(token, chatId, onboardingText(language, "complete"), appKeyboard(miniAppUrl, telegramUserId, language), telegramClient);
    }
    return sendMessage(token, chatId, onboardingText(language, "currentMonthBudget", { currency: user.base_currency ?? "THB" }), null, telegramClient);
  }

  if (step === "current_month_budget" || step === "month_opening_spend") {
    const amount = parseSingleAmount(text, user.base_currency ?? "THB");
    if (!amount || amount.amount <= 0) {
      return sendMessage(token, chatId, onboardingText(language, "currentMonthBudgetRetry", { currency: user.base_currency ?? "THB" }), null, telegramClient);
    }
    if (repository.setCurrentMonthBudget) {
      await repository.setCurrentMonthBudget(telegramUserId, {
        amount: amount.amount,
        currency: amount.currency,
        source: "onboarding",
        isPartialMonth: true,
        completeOnboarding: true
      }, now());
    } else {
      await repository.setMonthBaseline?.(telegramUserId, {
        amount: amount.amount,
        currency: amount.currency,
        sourceText: text
      });
      await repository.setOnboardingStep?.(telegramUserId, "completed");
    }
    return sendMessage(token, chatId, onboardingText(language, "complete"), appKeyboard(miniAppUrl, telegramUserId, language), telegramClient);
  }

  await repository.setOnboardingStep?.(telegramUserId, "completed");
  return sendMessage(token, chatId, onboardingText(language, "complete"), appKeyboard(miniAppUrl, telegramUserId, language), telegramClient);
}

function isOnboardingActive(user) {
  return ONBOARDING_STEPS.includes(user?.onboarding_step);
}

async function handleBudgetSetupMessage({ text, user, repository, token, chatId, miniAppUrl, telegramUserId, telegramClient, now }) {
  const language = user.interface_language ?? "en";
  const data = normalizeOnboardingData(user.onboarding_data);
  const currency = parseCurrencyFromText(text) ?? data.currency ?? null;
  const amount = parseSingleAmount(text, currency ?? user.base_currency ?? "THB");
  const monthlyBudgetAmount = amount?.amount ?? data.monthlyBudgetAmount ?? null;

  if (!currency && !monthlyBudgetAmount) {
    return sendMessage(token, chatId, onboardingText(language, "budgetSetupRetry"), null, telegramClient);
  }

  if (!currency) {
    await repository.updateOnboardingData?.(telegramUserId, { monthlyBudgetAmount });
    return sendMessage(token, chatId, onboardingText(language, "budgetSetupCurrencyMissing"), null, telegramClient);
  }

  if (!monthlyBudgetAmount || monthlyBudgetAmount <= 0) {
    await repository.updateOnboardingData?.(telegramUserId, { currency });
    return sendMessage(token, chatId, onboardingText(language, "budgetSetupAmountMissing", { currency }), null, telegramClient);
  }

  const nextStep = localMonthDay(now()) > 5 ? "current_month_budget" : "completed";
  if (repository.completeOnboardingBudgetSetup) {
    await repository.completeOnboardingBudgetSetup(telegramUserId, {
      baseCurrency: currency,
      monthlyBudgetAmount,
      nextStep
    });
  } else {
    await repository.updateUserSettings(telegramUserId, {
      monthlyBudgetAmount,
      baseCurrency: currency,
      displayCurrency: user.display_currency ?? "USD",
      usdThbRate: user.usd_thb_rate ?? 32.65,
      weeklyBudgetAmount: user.weekly_budget_amount ?? null,
      interfaceLanguage: language,
      onboardingStep: nextStep
    });
    await repository.updateOnboardingData?.(telegramUserId, {});
  }

  if (nextStep === "completed") {
    return sendMessage(token, chatId, onboardingText(language, "complete"), appKeyboard(miniAppUrl, telegramUserId, language), telegramClient);
  }
  return sendMessage(token, chatId, onboardingText(language, "currentMonthBudget", { currency }), null, telegramClient);
}

function onboardingPrompt(user) {
  const language = user?.interface_language ?? "en";
  if (user?.onboarding_step === "language") return onboardingText(language, "language");
  if (user?.onboarding_step === "budget_setup") return onboardingText(language, "introBudgetSetup");
  return onboardingText(language, "baseCurrency");
}

function onboardingReplyMarkup(user) {
  if (user?.onboarding_step === "language") return languageKeyboard();
  return null;
}

function languageKeyboard() {
  return {
    inline_keyboard: [[
      { text: "English", callback_data: "onboard_lang:en" },
      { text: "Русский", callback_data: "onboard_lang:ru" }
    ]]
  };
}

function parseLanguage(text) {
  const value = String(text ?? "").trim().toLowerCase();
  if (["en", "eng", "english"].includes(value)) return "en";
  if (["ru", "rus", "russian", "русский", "рус"].includes(value)) return "ru";
  return null;
}

function parseCurrency(text) {
  const value = String(text ?? "").trim().toLowerCase();
  const aliases = new Map([
    ["thai baht", "THB"], ["baht", "THB"], ["бат", "THB"], ["баты", "THB"],
    ["dollar", "USD"], ["usd", "USD"], ["доллар", "USD"], ["доллары", "USD"],
    ["rub", "RUB"], ["ruble", "RUB"], ["руб", "RUB"], ["рубль", "RUB"], ["рубли", "RUB"],
    ["idr", "IDR"], ["rupiah", "IDR"], ["рупия", "IDR"], ["рупии", "IDR"], ["индонезийские рупии", "IDR"],
    ["eur", "EUR"], ["euro", "EUR"], ["евро", "EUR"],
    ["byn", "BYN"], ["белорусский рубль", "BYN"],
    ["gel", "GEL"], ["лари", "GEL"]
  ]);
  const direct = normalizeCurrency(value, null);
  if (SUPPORTED_CURRENCY_CODES.includes(direct)) return direct;
  return aliases.get(value) ?? null;
}

function parseCurrencyFromText(text) {
  const direct = parseCurrency(text);
  if (direct) return direct;
  const value = String(text ?? "").toLowerCase();
  const tokens = value.match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const token of tokens) {
    const currency = parseCurrency(token);
    if (currency) return currency;
  }
  return null;
}

function parseSingleAmount(text, defaultCurrency) {
  const parsed = parseExpenseText(String(text ?? ""), { defaultCurrency });
  return parsed.expenses[0] ? { amount: parsed.expenses[0].amount, currency: parsed.expenses[0].currency } : null;
}

function isSkip(text) {
  return /^(0|skip|пропустить|нет)$/iu.test(String(text ?? "").trim());
}

function normalizeOnboardingData(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return typeof value === "object" ? value : {};
}

function localMonthDay(now) {
  const local = new Date(now.getTime() + 7 * 60 * 60_000);
  return local.getUTCDate();
}

async function handleCallback({ update, repository, token, miniAppUrl, telegramClient }) {
  const callback = update.callback_query;
  const [action, draftId, itemIndex, value] = callback.data.split(":");
  const telegramUserId = callback.from.id;
  const user = await repository.getUserByTelegramId?.(telegramUserId);
  const language = user?.interface_language ?? "en";

  if (action === "onboard_lang") {
    const selectedLanguage = ["en", "ru"].includes(draftId) ? draftId : "en";
    await updateOnboardingLanguage(repository, telegramUserId, selectedLanguage);
    await answerCallback(token, callback.id, selectedLanguage === "ru" ? "Язык выбран" : "Language selected", telegramClient);
    return sendMessage(token, callback.message.chat.id, onboardingText(selectedLanguage, "introBudgetSetup"), null, telegramClient);
  }

  if (action === "plan_confirm") {
    await repository.confirmPlannedDraft(draftId, telegramUserId);
    await answerCallback(token, callback.id, botText(language, "savedCallback"), telegramClient);
    return sendMessage(token, callback.message.chat.id, botText(language, "plannedSaved"), appKeyboard(miniAppUrl, telegramUserId, language), telegramClient);
  }

  if (action === "plan_cancel") {
    await repository.cancelPlannedDraft(draftId, telegramUserId);
    await answerCallback(token, callback.id, botText(language, "cancelledCallback"), telegramClient);
    return sendMessage(token, callback.message.chat.id, botText(language, "plannedCancelled"), null, telegramClient);
  }

  if (action === "cat") {
    const draft = await repository.getDraftForTelegramUser(draftId, telegramUserId);
    const items = updateDraftItem(draft, Number(itemIndex), { category_slug: value, needs_review: false, confidence: 0.9 });
    const updated = await repository.updateDraftItems(draftId, telegramUserId, items);
    await answerCallback(token, callback.id, botText(language, "categoryUpdatedCallback"), telegramClient);
    return sendMessage(token, callback.message.chat.id, formatDraft(updated.items, { language, baseCurrency: user?.base_currency ?? "THB" }), draftKeyboard(updated.id, updated.items, miniAppUrl, telegramUserId, language), telegramClient);
  }

  if (action === "amount") {
    const draft = await repository.getDraftForTelegramUser(draftId, telegramUserId);
    const current = draft.items[Number(itemIndex)];
    const amount = Math.max(Number(current.amount) + Number(value), 1);
    const items = updateDraftItem(draft, Number(itemIndex), { amount });
    const updated = await repository.updateDraftItems(draftId, telegramUserId, items);
    await answerCallback(token, callback.id, botText(language, "amountUpdatedCallback"), telegramClient);
    return sendMessage(token, callback.message.chat.id, formatDraft(updated.items, { language, baseCurrency: user?.base_currency ?? "THB" }), draftKeyboard(updated.id, updated.items, miniAppUrl, telegramUserId, language), telegramClient);
  }

  if (action === "impact") {
    const impact = normalizeBudgetImpact(value);
    const draft = await repository.getDraftForTelegramUser(draftId, telegramUserId);
    const items = updateDraftItem(draft, Number(itemIndex), { budget_impact: impact });
    const updated = await repository.updateDraftItems(draftId, telegramUserId, items);
    await answerCallback(token, callback.id, language === "ru" ? "Тип обновлен" : "Type updated", telegramClient);
    const text = formatDraft(updated.items, { language, baseCurrency: user?.base_currency ?? "THB" });
    const replyMarkup = draftKeyboard(updated.id, updated.items, miniAppUrl, telegramUserId, language);
    if (callback.message?.message_id) {
      return editMessageText(token, callback.message.chat.id, callback.message.message_id, text, replyMarkup, telegramClient);
    }
    return sendMessage(token, callback.message.chat.id, text, replyMarkup, telegramClient);
  }

  if (action === "confirm") {
    const expenses = await repository.confirmDraft(draftId, telegramUserId);
    const dashboard = await repository.dashboard(telegramUserId);
    const total = expenses.reduce((sum, expense) => sum + Number(expense.amount_base), 0);
    await answerCallback(token, callback.id, botText(language, "savedCallback"), telegramClient);
    return sendMessage(token, callback.message.chat.id, formatSavedSummary(total, dashboard.snapshot, { language }), appKeyboard(miniAppUrl, telegramUserId, language), telegramClient);
  }

  if (action === "cancel") {
    await repository.cancelDraft(draftId, telegramUserId);
    await answerCallback(token, callback.id, botText(language, "cancelledCallback"), telegramClient);
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;
    try {
      return await deleteMessage(token, chatId, messageId, telegramClient);
    } catch {
      return editMessageText(token, chatId, messageId, botText(language, "cancelledCallback"), { inline_keyboard: [] }, telegramClient);
    }
  }

  if (action === "inbox") {
    await repository.moveDraftToInbox(draftId, telegramUserId);
    await answerCallback(token, callback.id, botText(language, "movedCallback"), telegramClient);
    return sendMessage(token, callback.message.chat.id, botText(language, "movedToInbox"), inboxDraftKeyboard(miniAppUrl, telegramUserId, draftId, language), telegramClient);
  }

  await answerCallback(token, callback.id, botText(language, "openMiniAppCallback"), telegramClient);
  return sendMessage(token, callback.message.chat.id, botText(language, "editInMiniApp"), appKeyboard(miniAppUrl, telegramUserId, language), telegramClient);
}

async function updateOnboardingLanguage(repository, telegramUserId, language) {
  if (repository.updateOnboardingLanguage) {
    return repository.updateOnboardingLanguage(telegramUserId, language);
  }
  await repository.updateUserSettings?.(telegramUserId, {
    monthlyBudgetAmount: 45000,
    baseCurrency: "THB",
    displayCurrency: "USD",
    usdThbRate: 32.65,
    weeklyBudgetAmount: null,
    interfaceLanguage: language,
    onboardingStep: "budget_setup"
  });
  await repository.setOnboardingStep?.(telegramUserId, "budget_setup");
  await repository.updateOnboardingData?.(telegramUserId, {});
  return null;
}

function updateDraftItem(draft, index, patch) {
  if (!draft?.items?.[index]) throw new Error("Draft item not found");
  return draft.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item);
}

function normalizeBudgetImpact(value) {
  return ["regular", "planned", "large_oneoff"].includes(value) ? value : "regular";
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
      appKeyboard(miniAppUrl, Number(user.telegram_user_id), user.interface_language ?? "en")
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

async function sendMessage(token, chatId, text, replyMarkup, telegramClient) {
  if (telegramClient) {
    return telegramClient.sendMessage({ chatId, text, replyMarkup });
  }
  if (!token) {
    console.log("[telegram:sendMessage]", { chatId, text, replyMarkup });
    return { ok: true };
  }
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: replyMarkup
  };
  try {
    return await telegramRequest(token, "sendMessage", body);
  } catch (error) {
    if (!shouldRetryPlainText(error)) throw error;
    console.error("[telegram] sendMessage HTML rejected, retrying plain text", error.message);
    return telegramRequest(token, "sendMessage", {
      ...body,
      text: stripTelegramHtml(text),
      parse_mode: undefined
    });
  }
}

async function editMessageText(token, chatId, messageId, text, replyMarkup, telegramClient) {
  if (telegramClient) {
    return telegramClient.editMessageText({ chatId, messageId, text, replyMarkup });
  }
  if (!token) {
    console.log("[telegram:editMessageText]", { chatId, messageId, text, replyMarkup });
    return { ok: true };
  }
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    reply_markup: replyMarkup
  };
  try {
    return await telegramRequest(token, "editMessageText", body);
  } catch (error) {
    if (!shouldRetryPlainText(error)) throw error;
    console.error("[telegram] editMessageText HTML rejected, retrying plain text", error.message);
    return telegramRequest(token, "editMessageText", {
      ...body,
      text: stripTelegramHtml(text),
      parse_mode: undefined
    });
  }
}

async function deleteMessage(token, chatId, messageId, telegramClient) {
  if (telegramClient) {
    return telegramClient.deleteMessage({ chatId, messageId });
  }
  if (!token) {
    console.log("[telegram:deleteMessage]", { chatId, messageId });
    return { ok: true };
  }
  return telegramRequest(token, "deleteMessage", {
    chat_id: chatId,
    message_id: messageId
  });
}

async function answerCallback(token, callbackQueryId, text, telegramClient) {
  if (telegramClient) {
    return telegramClient.answerCallbackQuery({ callbackQueryId, text });
  }
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
    body: JSON.stringify(cleanTelegramBody(body))
  });
  if (!response.ok) {
    const responseBody = await response.text();
    const error = new Error(`Telegram ${method} failed: ${response.status} ${responseBody}`);
    error.status = response.status;
    error.body = responseBody;
    throw error;
  }
  return response.json();
}

function shouldRetryPlainText(error) {
  return error?.status === 400;
}

function stripTelegramHtml(text) {
  return String(text ?? "")
    .replaceAll(/<\/?b>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function cleanTelegramBody(body) {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value != null));
}

function onboardingText(language, key, values = {}) {
  const lang = language === "ru" ? "ru" : "en";
  const currency = values.currency ?? "THB";
  const messages = {
    ru: {
      language: "Choose language / Выбери язык:",
      languageRetry: "Please choose a language: English or Русский.",
      introBudgetSetup: [
        "Money Flow helps you save expenses from text or voice.",
        "Send expenses like: <b>coffee 70 baht and lunch 180</b>.",
        "I will show a draft first and save only after confirmation.",
        "",
        "Now send your currency and monthly budget in one message, for example: <b>THB 42000</b> or <b>USD 2000</b>."
      ].join("\n"),
      budgetSetupRetry: "I did not understand the currency and monthly budget. Send, for example: <b>THB 42000</b> or <b>USD 2000</b>.",
      budgetSetupCurrencyMissing: "Got the monthly budget. Now send the currency: <b>THB</b>, <b>USD</b>, <b>RUB</b>, <b>IDR</b>, <b>EUR</b>, <b>BYN</b>, or <b>GEL</b>.",
      budgetSetupAmountMissing: `Good, I will count in <b>${currency}</b>. Now send your monthly budget, for example: <b>42000</b> or <b>42k</b>.`,
      baseCurrency: [
        "Сначала быстро настроим учет.",
        "",
        "Напиши базовую валюту, в которой считать бюджет:",
        "<b>THB</b>, <b>USD</b>, <b>RUB</b>, <b>IDR</b>, <b>EUR</b>, <b>BYN</b> или <b>GEL</b>."
      ].join("\n"),
      baseCurrencyRetry: "Не понял валюту. Напиши, например: <b>THB</b>, <b>USD</b>, <b>RUB</b> или <b>IDR</b>.",
      monthlyBudget: `Ок, считаем в <b>${currency}</b>.\n\nТеперь напиши месячный бюджет. Например: <b>42000</b> или <b>42к</b>.`,
      monthlyBudgetRetry: `Не понял бюджет. Напиши сумму в ${currency}, например: <b>42000</b> или <b>42к</b>.`,
      openingSpend: [
        "Месяц уже начался.",
        "",
        `Сколько примерно ты уже потратил с 1 числа? Можно написать <b>0</b> или <b>пропустить</b>.`
      ].join("\n"),
      openingSpendRetry: `Не понял сумму. Напиши, например: <b>1500</b>, <b>1.5к</b> или <b>пропустить</b>.`,
      complete: "Готово, настройка завершена. Теперь можно писать расходы текстом или голосом.",
      monthlyBudget: `Ок, считаем в <b>${currency}</b>.\n\nСколько ты обычно планируешь тратить в месяц? Например: <b>42000</b> или <b>42к</b>.`,
      currentMonthBudget: [
        "Месяц уже начался",
        "",
        "Сколько ты хочешь оставить на расходы до конца этого месяца?",
        "",
        `<b>Бюджет до конца месяца</b> в ${currency}.`,
        "",
        "Это нужно только для первого месяца. Со следующего месяца мы будем использовать твой обычный месячный бюджет."
      ].join("\n"),
      currentMonthBudgetRetry: `Не понял бюджет до конца месяца. Напиши сумму в ${currency}, например: <b>15000</b> или <b>15к</b>.`
    },
    en: {
      language: "Choose language:",
      languageRetry: "Please choose a language: English or Russian.",
      introBudgetSetup: [
        "Money Flow helps you save expenses from text or voice.",
        "Write or dictate expenses like: <b>coffee 70 baht and lunch 180</b>.",
        "I will show a draft first and save only after confirmation.",
        "",
        "Now send your currency and monthly budget in one message, for example: <b>THB 42000</b> or <b>USD 2000</b>."
      ].join("\n"),
      budgetSetupRetry: "I did not understand the currency and monthly budget. Send, for example: <b>THB 42000</b> or <b>USD 2000</b>.",
      budgetSetupCurrencyMissing: "Got the monthly budget. Now send the currency: <b>THB</b>, <b>USD</b>, <b>RUB</b>, <b>IDR</b>, <b>EUR</b>, <b>BYN</b>, or <b>GEL</b>.",
      budgetSetupAmountMissing: `Good, I will count in <b>${currency}</b>. Now send your monthly budget, for example: <b>20000</b> or <b>20k</b>.`,
      baseCurrency: [
        "First, let's set up your account.",
        "",
        "Tell me your base currency for budgeting:",
        "<b>THB</b>, <b>USD</b>, <b>RUB</b>, <b>IDR</b>, <b>EUR</b>, <b>BYN</b>, or <b>GEL</b>."
      ].join("\n"),
      baseCurrencyRetry: "I did not understand the currency. Send, for example: <b>THB</b>, <b>USD</b>, <b>RUB</b>, or <b>IDR</b>.",
      monthlyBudget: `Good, I will count in <b>${currency}</b>.\n\nNow send your monthly budget. For example: <b>20000</b> or <b>20k</b>.`,
      monthlyBudgetRetry: `I did not understand the budget. Send an amount in ${currency}, for example: <b>20000</b> or <b>20k</b>.`,
      openingSpend: [
        "The month has already started.",
        "",
        "How much have you already spent from the 1st? You can send <b>0</b> or <b>skip</b>."
      ].join("\n"),
      openingSpendRetry: "I did not understand the amount. Send, for example: <b>1500</b>, <b>1.5k</b>, or <b>skip</b>.",
      complete: "Setup is complete. Now you can send expenses by text or voice.",
      monthlyBudget: `Good, I will count in <b>${currency}</b>.\n\nHow much do you usually plan to spend per month? For example: <b>20000</b> or <b>20k</b>.`,
      currentMonthBudget: [
        "The month has already started",
        "",
        "How much do you want to keep for spending until the end of this month?",
        "",
        `<b>Budget until the end of the month</b> in ${currency}.`,
        "",
        "This is only needed for your first month. Starting next month, we’ll use your regular monthly budget."
      ].join("\n"),
      currentMonthBudgetRetry: `I did not understand the budget until the end of the month. Send an amount in ${currency}, for example: <b>15000</b> or <b>15k</b>.`
    }
  };
  return messages[lang][key];
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
      plannedCancelled: "Плановая трата отменена.",
      plannedSaved: "Плановая трата добавлена. В день оплаты нажми «Оплатить», и она попадет в расходы.",
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
      plannedCancelled: "Planned expense cancelled.",
      plannedSaved: "Planned expense added. On the payment day, tap Pay and it will be saved as an expense.",
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
