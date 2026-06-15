import { createExpenseParser } from "./expenseParser.js";
import { parseExpenseText } from "../../../packages/shared/src/parser.js";
import { parsePlannedExpenseText } from "../../../packages/shared/src/plannedParser.js";
import { normalizeCurrency, SUPPORTED_CURRENCY_CODES } from "../../../packages/shared/src/currencies.js";
import { formatDraft, formatPlannedDraft, formatSavedSummary, formatTotals, formatWeeklyReport } from "./telegramFormat.js";
import { appKeyboard, draftKeyboard, inboxDraftKeyboard, plannedDraftKeyboard } from "./telegramKeyboards.js";

export function createTelegramBot({
  repository,
  token,
  miniAppUrl,
  expenseParser = createExpenseParser(),
  voiceTranscriber,
  telegramClient,
  perfLogger = console.info,
  now = () => new Date()
}) {
  return {
    async handleUpdate(update) {
      const trace = createPerfTrace({ update, logger: perfLogger });
      let success = false;
      if (update.message) {
        try {
          const result = await handleMessage({ update, repository, token, miniAppUrl, expenseParser, voiceTranscriber, telegramClient, now, trace });
          success = true;
          return result;
        } catch (error) {
          trace.finish(false, error);
          throw error;
        } finally {
          if (success) trace.finish(true);
        }
      }
      if (update.callback_query) {
        try {
          const result = await handleCallback({ update, repository, token, miniAppUrl, telegramClient, trace });
          success = true;
          return result;
        } catch (error) {
          trace.finish(false, error);
          throw error;
        } finally {
          if (success) trace.finish(true);
        }
      }
      trace.finish(true);
      return { ok: true };
    }
  };
}

async function handleMessage({ update, repository, token, miniAppUrl, expenseParser, voiceTranscriber, telegramClient, now, trace }) {
  const message = update.message;
  const from = message.from;
  if (!from) return { ok: true };

  trace.start("user_context");
  const user = await repository.upsertTelegramUser({
    id: from.id,
    firstName: from.first_name,
    username: from.username
  });
  trace.end("user_context");
  const language = user.interface_language ?? "en";

  const text = await messageText({ message, voiceTranscriber, trace });
  if (!text) return sendTelegramResponse(trace, () => sendMessage(token, message.chat.id, botText(language, "unsupported"), null, telegramClient));

  if (text === "/start") {
    if (isOnboardingActive(user)) {
      return sendTelegramResponse(trace, () => sendMessage(token, message.chat.id, onboardingText(language, "baseCurrency"), appKeyboard(miniAppUrl, from.id, language), telegramClient));
    }
    return sendTelegramResponse(trace, () => sendMessage(token, message.chat.id, botText(language, "start"), appKeyboard(miniAppUrl, from.id, language), telegramClient));
  }

  if (text === "/today" || text === "/week" || text === "/month" || text === "/budget") {
    const dashboard = await repository.dashboard(from.id);
    return sendTelegramResponse(trace, () => sendMessage(token, message.chat.id, formatTotals(text, dashboard.snapshot, { language }), appKeyboard(miniAppUrl, from.id, language), telegramClient));
  }

  if (text === "/app" || text === "/settings") {
    return sendTelegramResponse(trace, () => sendMessage(token, message.chat.id, botText(language, "openMiniApp"), appKeyboard(miniAppUrl, from.id, language), telegramClient));
  }

  if (isOnboardingActive(user)) {
    return handleOnboardingMessage({ text, user, repository, token, chatId: message.chat.id, miniAppUrl, telegramUserId: from.id, telegramClient, now, trace });
  }

  const planned = parsePlannedExpenseText(text, { defaultCurrency: user.base_currency ?? "THB" });
  if (planned) {
    trace.start("db_save");
    const draft = await repository.createPlannedDraft(user.id, text, planned);
    trace.end("db_save");
    return sendTelegramResponse(
      trace,
      () => sendMessage(
        token,
        message.chat.id,
        formatPlannedDraft(planned, { language }),
        plannedDraftKeyboard(draft.id, miniAppUrl, from.id, language),
        telegramClient
      )
    );
  }

  let llmMetadata = {
    model: expenseParser.model,
    promptChars: String(text ?? "").length
  };
  trace.start("llm_parse", llmMetadata);
  const parsed = await expenseParser.parse(text, {
    defaultCurrency: user.base_currency ?? "THB",
    onLlmTrace(metadata) {
      llmMetadata = { ...llmMetadata, ...metadata };
    }
  });
  trace.end("llm_parse", llmMetadata);
  if (parsed.expenses.length === 0) {
    return sendTelegramResponse(trace, () => sendMessage(token, message.chat.id, botText(language, "amountNotFound"), null, telegramClient));
  }

  trace.start("db_save");
  const draft = await repository.createDraft(user.id, text, parsed.expenses);
  trace.end("db_save");
  return sendTelegramResponse(trace, () => sendMessage(token, message.chat.id, formatDraft(parsed.expenses, { language, baseCurrency: user.base_currency ?? "THB" }), draftKeyboard(draft.id, parsed.expenses, miniAppUrl, from.id, language), telegramClient));
}

async function messageText({ message, voiceTranscriber, trace }) {
  if (message.text?.trim()) return message.text.trim();
  const voice = message.voice ?? message.audio;
  if (!voice) return null;
  if (!voiceTranscriber?.isConfigured()) return null;

  try {
    return await voiceTranscriber.transcribeTelegramVoice(voice, {
      onPerfStage(stage, metadata = {}) {
        if (stage.endsWith("_start")) {
          trace.start(stage.replace(/_start$/, ""), metadata);
        } else if (stage.endsWith("_end")) {
          trace.end(stage.replace(/_end$/, ""), metadata);
        } else {
          trace.event(stage, metadata);
        }
      }
    });
  } catch (error) {
    trace.failActive(["telegram_file_download", "transcription"], error);
    console.error("[telegram] voice transcription failed", error.message);
    return null;
  }
}

async function handleOnboardingMessage({ text, user, repository, token, chatId, miniAppUrl, telegramUserId, telegramClient, now, trace }) {
  const language = user.interface_language ?? "en";
  const step = user.onboarding_step ?? "completed";

  if (step === "base_currency") {
    const currency = parseCurrency(text);
    if (!currency) {
      return sendTelegramResponse(trace, () => sendMessage(token, chatId, onboardingText(language, "baseCurrencyRetry"), null, telegramClient));
    }
    trace.start("db_save");
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
    trace.end("db_save");
    return sendTelegramResponse(trace, () => sendMessage(token, chatId, onboardingText(language, "monthlyBudget", { currency }), null, telegramClient));
  }

  if (step === "monthly_budget") {
    const amount = parseSingleAmount(text, user.base_currency ?? "THB");
    if (!amount || amount.amount <= 0) {
      return sendTelegramResponse(trace, () => sendMessage(token, chatId, onboardingText(language, "monthlyBudgetRetry", { currency: user.base_currency ?? "THB" }), null, telegramClient));
    }
    const nextStep = localMonthDay(now()) > 5 ? "current_month_budget" : "completed";
    trace.start("db_save");
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
      trace.end("db_save");
      return sendTelegramResponse(trace, () => sendMessage(token, chatId, onboardingText(language, "complete"), appKeyboard(miniAppUrl, telegramUserId, language), telegramClient));
    }
    trace.end("db_save");
    return sendTelegramResponse(trace, () => sendMessage(token, chatId, onboardingText(language, "currentMonthBudget", { currency: user.base_currency ?? "THB" }), null, telegramClient));
  }

  if (step === "current_month_budget" || step === "month_opening_spend") {
    const amount = parseSingleAmount(text, user.base_currency ?? "THB");
    if (!amount || amount.amount <= 0) {
      return sendTelegramResponse(trace, () => sendMessage(token, chatId, onboardingText(language, "currentMonthBudgetRetry", { currency: user.base_currency ?? "THB" }), null, telegramClient));
    }
    trace.start("db_save");
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
    trace.end("db_save");
    return sendTelegramResponse(trace, () => sendMessage(token, chatId, onboardingText(language, "complete"), appKeyboard(miniAppUrl, telegramUserId, language), telegramClient));
  }

  trace.start("db_save");
  await repository.setOnboardingStep?.(telegramUserId, "completed");
  trace.end("db_save");
  return sendTelegramResponse(trace, () => sendMessage(token, chatId, onboardingText(language, "complete"), appKeyboard(miniAppUrl, telegramUserId, language), telegramClient));
}

function isOnboardingActive(user) {
  return ["base_currency", "monthly_budget", "current_month_budget", "month_opening_spend"].includes(user?.onboarding_step);
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

function parseSingleAmount(text, defaultCurrency) {
  const parsed = parseExpenseText(String(text ?? ""), { defaultCurrency });
  return parsed.expenses[0] ? { amount: parsed.expenses[0].amount, currency: parsed.expenses[0].currency } : null;
}

function isSkip(text) {
  return /^(0|skip|пропустить|нет)$/iu.test(String(text ?? "").trim());
}

function localMonthDay(now) {
  const local = new Date(now.getTime() + 7 * 60 * 60_000);
  return local.getUTCDate();
}

async function handleCallback({ update, repository, token, miniAppUrl, telegramClient, trace }) {
  const callback = update.callback_query;
  const [action, draftId, itemIndex, value] = callback.data.split(":");
  const telegramUserId = callback.from.id;
  trace.start("user_context");
  const user = await repository.getUserByTelegramId?.(telegramUserId);
  trace.end("user_context");
  const language = user?.interface_language ?? "en";

  if (action === "plan_confirm") {
    trace.start("db_save");
    await repository.confirmPlannedDraft(draftId, telegramUserId);
    trace.end("db_save");
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, botText(language, "savedCallback"), telegramClient);
      return sendMessage(token, callback.message.chat.id, botText(language, "plannedSaved"), appKeyboard(miniAppUrl, telegramUserId, language), telegramClient);
    });
  }

  if (action === "plan_cancel") {
    trace.start("db_save");
    await repository.cancelPlannedDraft(draftId, telegramUserId);
    trace.end("db_save");
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, botText(language, "cancelledCallback"), telegramClient);
      return sendMessage(token, callback.message.chat.id, botText(language, "plannedCancelled"), null, telegramClient);
    });
  }

  if (action === "cat") {
    trace.start("db_save");
    const draft = await repository.getDraftForTelegramUser(draftId, telegramUserId);
    const items = updateDraftItem(draft, Number(itemIndex), { category_slug: value, needs_review: false, confidence: 0.9 });
    const updated = await repository.updateDraftItems(draftId, telegramUserId, items);
    trace.end("db_save");
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, botText(language, "categoryUpdatedCallback"), telegramClient);
      return sendMessage(token, callback.message.chat.id, formatDraft(updated.items, { language, baseCurrency: user?.base_currency ?? "THB" }), draftKeyboard(updated.id, updated.items, miniAppUrl, telegramUserId, language), telegramClient);
    });
  }

  if (action === "amount") {
    trace.start("db_save");
    const draft = await repository.getDraftForTelegramUser(draftId, telegramUserId);
    const current = draft.items[Number(itemIndex)];
    const amount = Math.max(Number(current.amount) + Number(value), 1);
    const items = updateDraftItem(draft, Number(itemIndex), { amount });
    const updated = await repository.updateDraftItems(draftId, telegramUserId, items);
    trace.end("db_save");
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, botText(language, "amountUpdatedCallback"), telegramClient);
      return sendMessage(token, callback.message.chat.id, formatDraft(updated.items, { language, baseCurrency: user?.base_currency ?? "THB" }), draftKeyboard(updated.id, updated.items, miniAppUrl, telegramUserId, language), telegramClient);
    });
  }

  if (action === "impact") {
    trace.start("db_save");
    const impact = normalizeBudgetImpact(value);
    const draft = await repository.getDraftForTelegramUser(draftId, telegramUserId);
    const items = updateDraftItem(draft, Number(itemIndex), { budget_impact: impact });
    const updated = await repository.updateDraftItems(draftId, telegramUserId, items);
    trace.end("db_save");
    const text = formatDraft(updated.items, { language, baseCurrency: user?.base_currency ?? "THB" });
    const replyMarkup = draftKeyboard(updated.id, updated.items, miniAppUrl, telegramUserId, language);
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, language === "ru" ? "Тип обновлен" : "Type updated", telegramClient);
      if (callback.message?.message_id) {
        return editMessageText(token, callback.message.chat.id, callback.message.message_id, text, replyMarkup, telegramClient);
      }
      return sendMessage(token, callback.message.chat.id, text, replyMarkup, telegramClient);
    });
  }

  if (action === "confirm") {
    trace.start("db_save");
    const expenses = await repository.confirmDraft(draftId, telegramUserId);
    const dashboard = await repository.dashboard(telegramUserId);
    const total = expenses.reduce((sum, expense) => sum + Number(expense.amount_base), 0);
    trace.end("db_save");
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, botText(language, "savedCallback"), telegramClient);
      return sendMessage(token, callback.message.chat.id, formatSavedSummary(total, dashboard.snapshot, { language }), appKeyboard(miniAppUrl, telegramUserId, language), telegramClient);
    });
  }

  if (action === "cancel") {
    trace.start("db_save");
    await repository.cancelDraft(draftId, telegramUserId);
    trace.end("db_save");
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, botText(language, "cancelledCallback"), telegramClient);
      try {
        return await deleteMessage(token, chatId, messageId, telegramClient);
      } catch {
        return editMessageText(token, chatId, messageId, botText(language, "cancelledCallback"), { inline_keyboard: [] }, telegramClient);
      }
    });
  }

  if (action === "inbox") {
    trace.start("db_save");
    await repository.moveDraftToInbox(draftId, telegramUserId);
    trace.end("db_save");
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, botText(language, "movedCallback"), telegramClient);
      return sendMessage(token, callback.message.chat.id, botText(language, "movedToInbox"), inboxDraftKeyboard(miniAppUrl, telegramUserId, draftId, language), telegramClient);
    });
  }

  return sendTelegramResponse(trace, async () => {
    await answerCallback(token, callback.id, botText(language, "openMiniAppCallback"), telegramClient);
    return sendMessage(token, callback.message.chat.id, botText(language, "editInMiniApp"), appKeyboard(miniAppUrl, telegramUserId, language), telegramClient);
  });
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

async function sendTelegramResponse(trace, fn) {
  trace.start("telegram_response");
  try {
    const result = await fn();
    trace.end("telegram_response");
    return result;
  } catch (error) {
    trace.end("telegram_response", {}, false, error);
    throw error;
  }
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

function createPerfTrace({ update, logger }) {
  const startedAt = performance.now();
  const traceId = createTraceId();
  const messageType = resolveMessageType(update);
  const userId = update.message?.from?.id ?? update.callback_query?.from?.id ?? null;
  const starts = new Map();
  const durations = new Map();
  let finished = false;

  const trace = {
    start(stage, metadata = {}) {
      starts.set(stage, performance.now());
      logStage(`${stage}_start`, 0, true, metadata);
    },

    end(stage, metadata = {}, success = true, error = null) {
      const started = starts.get(stage);
      const durationMs = started ? elapsedSince(started) : 0;
      starts.delete(stage);
      durations.set(stage, durationMs);
      logStage(`${stage}_end`, durationMs, success, metadata, error);
    },

    event(stage, metadata = {}, success = true, error = null) {
      logStage(stage, 0, success, metadata, error);
    },

    failActive(stages, error) {
      for (const stage of stages) {
        if (starts.has(stage)) {
          trace.end(stage, {}, false, error);
        }
      }
    },

    finish(success, error = null) {
      if (finished) return;
      trace.failActive([...starts.keys()], error);
      finished = true;
      logStage("total_done", elapsedSince(startedAt), success, {}, error);
      logSummary(success, error);
    }
  };

  trace.event("message_received", messageMetadata(update, messageType));
  return trace;

  function logStage(stage, durationMs, success, metadata = {}, error = null) {
    const payload = {
      traceId,
      userId,
      messageType,
      stage,
      durationMs,
      totalMs: elapsedSince(startedAt),
      success,
      ...metadata
    };
    if (error) payload.error = error.message;
    logger(formatPerfStage(payload));
  }

  function logSummary(success, error = null) {
    const parts = [
      "[perf]",
      `traceId=${traceId}`,
      `type=${messageType}`,
      `total=${elapsedSince(startedAt)}ms`
    ];
    appendDuration(parts, "download", durations.get("telegram_file_download"));
    appendDuration(parts, "transcription", durations.get("transcription"));
    appendDuration(parts, "llm", durations.get("llm_parse"));
    appendDuration(parts, "db", durations.get("db_save"));
    appendDuration(parts, "telegram", durations.get("telegram_response"));
    if (!success) parts.push("success=false");
    if (error) parts.push(`error=${formatPerfValue(error.message)}`);
    logger(parts.join(" "));
  }
}

function resolveMessageType(update) {
  if (update.callback_query) return "callback";
  const message = update.message;
  if (message?.text) return "text";
  if (message?.voice || message?.audio) return "voice";
  if (message?.photo) return "photo";
  return "unknown";
}

function messageMetadata(update, messageType) {
  const message = update.message;
  if (!message) return {};
  const metadata = {};
  if (messageType === "text") {
    metadata.textChars = String(message.text ?? "").length;
  }
  if (messageType === "voice") {
    const voice = message.voice ?? message.audio;
    metadata.audioDurationSec = voice?.duration;
    if (voice?.file_size) metadata.fileSizeKb = Math.round(Number(voice.file_size) / 1024);
  }
  return metadata;
}

function createTraceId() {
  return `tg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function elapsedSince(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function appendDuration(parts, label, durationMs) {
  if (Number.isFinite(durationMs)) parts.push(`${label}=${durationMs}ms`);
}

function formatPerfStage(payload) {
  const fields = Object.entries(payload)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${formatPerfValue(value)}`);
  return `[perf:stage] ${fields.join(" ")}`;
}

function formatPerfValue(value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value).replaceAll(/\s+/g, " ").slice(0, 160);
  return /^[A-Za-z0-9_.:/-]+$/.test(text) ? text : JSON.stringify(text);
}

function onboardingText(language, key, values = {}) {
  const lang = language === "ru" ? "ru" : "en";
  const currency = values.currency ?? "THB";
  const messages = {
    ru: {
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
