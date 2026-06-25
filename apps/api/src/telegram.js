import { createExpenseParser } from "./expenseParser.js";
import { parseExpenseText } from "../../../packages/shared/src/parser.js";
import { parsePlannedExpenseText } from "../../../packages/shared/src/plannedParser.js";
import { normalizeCurrency, SUPPORTED_CURRENCY_CODES } from "../../../packages/shared/src/currencies.js";
import { isAdminTelegramId, normalizeBotCommand } from "./adminAccess.js";
import {
  localDateKey as timezoneLocalDateKey,
  localHour as timezoneLocalHour,
  localMonthDay as timezoneLocalMonthDay,
  localWeekday as timezoneLocalWeekday,
  normalizeTimeZone
} from "../../../packages/shared/src/time.js";
import { formatAdminStats } from "./adminStatsService.js";
import { createTelegramJobQueue } from "./telegramJobQueue.js";
import { formatDraft, formatPlannedDraft, formatReserveClosedEvent, formatSavedSummary, formatTotals, formatWeeklyReport } from "./telegramFormat.js";
import { appKeyboard, draftKeyboard, inboxDraftKeyboard, plannedDraftKeyboard } from "./telegramKeyboards.js";

// budget_setup is the primary onboarding path; base_currency/monthly_budget/month_opening_spend are legacy fallback states.
const ONBOARDING_STEPS = ["language", "budget_setup", "base_currency", "monthly_budget", "current_month_budget", "month_opening_spend"];

export function createTelegramBot({
  repository,
  token,
  miniAppUrl,
  expenseParser = createExpenseParser(),
  voiceTranscriber,
  telegramClient,
  perfLogger = console.info,
  adminTelegramIds = new Set(),
  adminStatsService,
  releaseNotesService,
  now = () => new Date(),
  telegramJobQueueOptions = {},
  telegramJobQueue = createTelegramJobQueue(telegramJobQueueOptions),
  awaitQueuedJobs = true
}) {
  return {
    async handleUpdate(update) {
      const trace = createPerfTrace({ update, logger: perfLogger });
      let success = false;
      if (update.message) {
        try {
          const result = await handleMessage({ update, repository, token, miniAppUrl, expenseParser, voiceTranscriber, telegramClient, adminTelegramIds, adminStatsService, releaseNotesService, now, trace, telegramJobQueue, awaitQueuedJobs });
          success = !result?.queued;
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
          const result = await handleCallback({ update, repository, token, miniAppUrl, telegramClient, trace, now });
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

async function handleMessage({ update, repository, token, miniAppUrl, expenseParser, voiceTranscriber, telegramClient, adminTelegramIds, adminStatsService, releaseNotesService, now, trace, telegramJobQueue, awaitQueuedJobs }) {
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
  const chatId = message.chat.id;

  const rawText = message.text?.trim() || null;
  const commandText = normalizeBotCommand(rawText);
  const hasVoice = Boolean(message.voice || message.audio);
  const hasPhoto = Boolean(message.photo?.length);

  if (!rawText && !hasVoice && !hasPhoto) {
    return sendTelegramResponse(trace, () => sendMessage(token, chatId, botText(language, "unsupported"), null, telegramClient));
  }
  if (hasVoice && !rawText && !voiceTranscriber?.isConfigured()) {
    return sendTelegramResponse(trace, () => sendMessage(token, chatId, botText(language, "unsupported"), null, telegramClient));
  }

  if (rawText && !hasVoice) {
    if (isAdminReleaseCommand(commandText)) {
      return handleAdminReleaseCommand({
        text: commandText,
        from,
        chatId,
        token,
        telegramClient,
        adminTelegramIds,
        releaseNotesService,
        now,
        trace
      });
    }

    if (commandText === "/admin_stats") {
      if (!isAdminTelegramId(from.id, adminTelegramIds)) {
        console.warn("[admin] access denied", {
          command: "/admin_stats",
          fromId: from.id,
          username: from.username ?? null,
          chatId,
          adminIdsCount: adminTelegramIds.size,
          adminEnvConfigured: adminTelegramIds.size > 0
        });
        return sendTelegramResponse(trace, () => sendMessage(token, chatId, "Access denied", null, telegramClient));
      }
      if (!adminStatsService?.getAdminStats) {
        return sendTelegramResponse(trace, () => sendMessage(token, chatId, "Admin stats unavailable", null, telegramClient));
      }
      try {
        const stats = await adminStatsService.getAdminStats();
        return sendTelegramResponse(trace, () => sendMessage(token, chatId, formatAdminStats(stats), null, telegramClient));
      } catch (error) {
        console.error("[telegram] admin stats failed", error);
        return sendTelegramResponse(trace, () => sendMessage(token, chatId, "Admin stats unavailable", null, telegramClient));
      }
    }

    if (commandText === "/start") {
      if (isOnboardingActive(user)) {
        return sendTelegramResponse(trace, () => sendMessage(token, chatId, onboardingPrompt(user), onboardingReplyMarkup(user), telegramClient));
      }
      return sendTelegramResponse(trace, () => sendMessage(token, chatId, botText(language, "start"), appKeyboard(miniAppUrl, from.id, language), telegramClient));
    }

    if (commandText === "/today" || commandText === "/week" || commandText === "/month" || commandText === "/budget") {
      const dashboard = await repository.dashboard(from.id);
      const event = await repository.latestPendingTelegramReserveEvent?.(from.id);
      const text = event
        ? `${formatReserveClosedEvent(event, { language })}\n\n${formatTotals(commandText, dashboard.snapshot, { language })}`
        : formatTotals(commandText, dashboard.snapshot, { language });
      const sent = await sendTelegramResponse(trace, () => sendMessage(token, chatId, text, appKeyboard(miniAppUrl, from.id, language), telegramClient));
      if (event) await repository.markTelegramReserveEventDelivered?.(event.id);
      return sent;
    }

    if (commandText === "/app" || commandText === "/settings") {
      return sendTelegramResponse(trace, () => sendMessage(token, chatId, botText(language, "openMiniApp"), appKeyboard(miniAppUrl, from.id, language), telegramClient));
    }
  }

  const inputType = hasPhoto ? "photo" : (hasVoice ? "voice" : "text");
  const trackExpenseMessage = !isOnboardingActive(user);
  if (trackExpenseMessage) {
    await safeRecordAppEvent(repository, user.id, "message_received", { inputType });
  }

  const queued = telegramJobQueue.enqueue({
    userId: from.id,
    run: () => processQueuedMessage({ message, from, user, rawText, hasVoice, inputType: trackExpenseMessage ? inputType : null, repository, token, miniAppUrl, expenseParser, voiceTranscriber, telegramClient, now, trace }),
    onStart: (metadata) => trace.event("queue_job_start", metadata),
    onFinish: (metadata) => trace.event("queue_job_done", metadata)
  });

  trace.event("queue_enqueue", {
    status: queued.status,
    queueDepth: queued.stats.queueDepth,
    globalActiveJobs: queued.stats.globalActiveJobs,
    userPendingJobs: queued.stats.userPendingJobs
  }, queued.accepted);

  if (!queued.accepted) {
    const key = queued.status === "globalQueueFull" ? "globalQueueFull" : "userQueueFull";
    return sendTelegramResponse(trace, () => sendMessage(token, chatId, botText(language, key), null, telegramClient));
  }

  if (queued.status === "queuedBehindPrevious") {
    await sendTelegramResponse(trace, () => sendMessage(token, chatId, botText(language, "queuedBehindPrevious"), null, telegramClient));
  } else if (queued.status === "globalQueueDelayed") {
    await sendTelegramResponse(trace, () => sendMessage(token, chatId, botText(language, "globalQueueDelayed"), null, telegramClient));
  }

  if (awaitQueuedJobs) {
    try {
      await queued.promise;
    } catch (error) {
      await sendQueuedJobFailure({ error, token, chatId, language, telegramClient, trace });
    }
    return { ok: true };
  }

  queued.promise
    .then(() => trace.finish(true))
    .catch(async (error) => {
      await sendQueuedJobFailure({ error, token, chatId, language, telegramClient, trace });
      trace.finish(false, error);
    });
  return { ok: true, queued: true };
}

async function sendQueuedJobFailure({ error, token, chatId, language, telegramClient, trace }) {
  trace.failActive(["telegram_file_download", "transcription", "llm_parse", "db_save"], error);
  console.error("[telegram] queued job failed", error.message);
  try {
    await sendTelegramResponse(trace, () => sendMessage(token, chatId, botText(language, "jobProcessingFailed"), null, telegramClient));
  } catch (sendError) {
    console.error("[telegram] failed to send queued job failure message", sendError.message);
  }
}

async function processQueuedMessage({ message, from, user, rawText, hasVoice, inputType, repository, token, miniAppUrl, expenseParser, voiceTranscriber, telegramClient, now, trace }) {
  const processingStartedAt = performance.now();
  const language = user.interface_language ?? "en";
  const chatId = message.chat.id;
  let processingResult = inputType ? "processing_failed" : undefined;
  let processingDraftType;

  try {
    if (isOnboardingActive(user)) {
      let onboardingTextInput = rawText;
      if (!onboardingTextInput && hasVoice) {
        try {
          onboardingTextInput = await transcribeVoice(message, voiceTranscriber, trace);
        } catch (error) {
          trace.failActive(["telegram_file_download", "transcription"], error);
          console.error("[telegram] voice transcription failed during onboarding", error.message);
          onboardingTextInput = null;
        }
      }
      if (!onboardingTextInput) {
        return sendTelegramResponse(trace, () => sendMessage(token, chatId, botText(language, "unsupported"), null, telegramClient));
      }
      return handleOnboardingMessage({ text: onboardingTextInput, user, repository, token, chatId, miniAppUrl, telegramUserId: from.id, telegramClient, now, trace });
    }

    const loader = await sendExpenseProcessingMessage(token, chatId, language, telegramClient, trace);
    try {
      let text = rawText;
      if (!text && hasVoice) {
        try {
          text = await transcribeVoice(message, voiceTranscriber, trace);
        } catch (error) {
          processingResult = "transcription_failed";
          await safeRecordAppEvent(repository, user.id, "voice_transcription_failed", { result: "transcription_failed" });
          throw error;
        }
      }
      if (!text && inputType === "photo") {
        processingResult = "unsupported_photo";
        await safeRecordAppEvent(repository, user.id, "unsupported_photo_input", { inputType: "photo" });
        return deliverResultMessage({
          token,
          chatId,
          loaderMessageId: loader.messageId,
          text: botText(language, "unsupportedPhoto"),
          replyMarkup: null,
          telegramClient,
          trace
        });
      }
      if (!text) {
        throw new Error("No text to process");
      }

      let planned;
      try {
        planned = parsePlannedExpenseText(text, {
          defaultCurrency: user.base_currency ?? "THB",
          timeZone: user.timezone
        });
      } catch (error) {
        processingResult = "parser_failed";
        await safeRecordAppEvent(repository, user.id, "expense_parse_failed", { inputType });
        throw error;
      }
      if (planned) {
        trace.start("db_save");
        const draft = await repository.createPlannedDraft(user.id, text, planned);
        trace.end("db_save");
        await safeRecordAppEvent(repository, user.id, "expense_draft_created", { inputType, draftType: "planned" });
        processingResult = "planned_draft_created";
        processingDraftType = "planned";
        return deliverResultMessage({
          token,
          chatId,
          loaderMessageId: loader.messageId,
          text: formatPlannedDraft(planned, { language }),
          replyMarkup: plannedDraftKeyboard(draft.id, miniAppUrl, from.id, language),
          telegramClient,
          trace
        });
      }

      let llmMetadata = {
        model: expenseParser.model,
        promptChars: String(text ?? "").length
      };
      trace.start("llm_parse", llmMetadata);
      let parsed;
      try {
        parsed = await expenseParser.parse(text, {
          defaultCurrency: user.base_currency ?? "THB",
          timeZone: user.timezone,
          onLlmTrace(metadata) {
            llmMetadata = { ...llmMetadata, ...metadata };
          }
        });
      } catch (error) {
        processingResult = "parser_failed";
        await safeRecordAppEvent(repository, user.id, "expense_parse_failed", { inputType });
        throw error;
      }
      trace.end("llm_parse", llmMetadata);
      if (parsed.expenses.length === 0) {
        processingResult = "amount_not_found";
        await safeRecordAppEvent(repository, user.id, "expense_parse_failed", { inputType });
        return deliverResultMessage({
          token,
          chatId,
          loaderMessageId: loader.messageId,
          text: inputType === "voice" && text
            ? botText(language, "amountNotFoundWithTranscript", { transcript: text })
            : botText(language, "amountNotFound"),
          replyMarkup: null,
          telegramClient,
          trace
        });
      }

      trace.start("db_save");
      const draft = await repository.createDraft(user.id, text, parsed.expenses);
      trace.end("db_save");
      await safeRecordAppEvent(repository, user.id, "expense_draft_created", { inputType, draftType: "regular" });
      processingResult = "draft_created";
      processingDraftType = "regular";
      return deliverResultMessage({
        token,
        chatId,
        loaderMessageId: loader.messageId,
        text: formatDraft(parsed.expenses, { language, baseCurrency: user.base_currency ?? "THB" }),
        replyMarkup: draftKeyboard(draft.id, parsed.expenses, miniAppUrl, from.id, language),
        telegramClient,
        trace
      });
    } catch (error) {
      trace.failActive(["telegram_file_download", "transcription", "llm_parse", "db_save"], error);
      console.error("[telegram] expense processing failed", error.message);
      return deliverResultMessage({
        token,
        chatId,
        loaderMessageId: loader.messageId,
        text: processingResult === "transcription_failed"
          ? botText(language, "transcriptionFailed")
          : (processingResult === "parser_failed" ? botText(language, "parseFailed") : botText(language, "jobProcessingFailed")),
        replyMarkup: null,
        telegramClient,
        trace
      });
    }
  } finally {
    if (inputType) {
      const stageDurations = trace.getDurations();
      const traceMetadata = trace.getMetadata();
      await safeRecordAppEvent(repository, user.id, "message_processing_completed", {
        inputType,
        result: processingResult,
        status: processingResult,
        draftType: processingDraftType,
        processingTotalMs: Math.max(0, Math.round(performance.now() - processingStartedAt)),
        queueWaitMs: traceMetadata.queueWaitMs,
        telegramResponseMs: stageDurations.telegram_response,
        llmParseMs: stageDurations.llm_parse,
        dbSaveMs: stageDurations.db_save,
        telegramFileDownloadMs: stageDurations.telegram_file_download,
        transcriptionMs: stageDurations.transcription,
        model: traceMetadata.llmParse?.model,
        promptChars: traceMetadata.llmParse?.promptChars,
        responseChars: traceMetadata.llmParse?.responseChars,
        fallback: traceMetadata.llmParse?.fallback,
        audioDurationSec: inputType === "voice" ? traceMetadata.audioDurationSec : undefined
      });
    }
  }
}

async function safeRecordAppEvent(repository, userId, eventName, metadata = {}) {
  try {
    await repository.recordAppEvent?.(userId, eventName, metadata);
  } catch (error) {
    console.warn("[events] record failed", {
      userId: userId ?? null,
      eventName,
      message: error.message
    });
  }
}

function isAdminReleaseCommand(text) {
  return text === "/admin_release_preview" || text === "/admin_release_send";
}

async function handleAdminReleaseCommand({ text, from, chatId, token, telegramClient, adminTelegramIds, releaseNotesService, now, trace }) {
  if (!isAdminTelegramId(from.id, adminTelegramIds) || !releaseNotesService) {
    return sendTelegramResponse(trace, () => sendMessage(token, chatId, "Команда доступна только администратору.", null, telegramClient));
  }

  if (text === "/admin_release_preview") {
    const preview = await releaseNotesService.previewReleaseDigestSinceLastRun(now());
    return sendTelegramResponse(trace, () => sendMessage(token, chatId, preview.text, null, telegramClient));
  }

  const result = await releaseNotesService.sendReleaseDigestSinceLastRun(now(), {
    trigger: "manual"
  });
  if (!result.sent && (result.reason === "digest_already_running" || result.reason === "duplicate_auto_run")) {
    return sendTelegramResponse(trace, () => sendMessage(token, chatId, "Release digest уже выполняется — повторный запуск не нужен.", null, telegramClient));
  }
  if (!result.sent && result.reason === "no_public_release_notes") {
    return sendTelegramResponse(trace, () => sendMessage(token, chatId, "Нет новых публичных изменений для пользователей с прошлого дайджеста — отправлять нечего.", null, telegramClient));
  }
  return sendTelegramResponse(trace, () => sendMessage(token, chatId, formatReleaseSendSummary(result), null, telegramClient));
}

function formatReleaseSendSummary(result) {
  const versionLine = formatReleaseVersionLine(result);
  return [
    "Release digest отправлен.",
    versionLine,
    `Пользователей: ${result.users}`,
    `Успешно: ${result.success}`,
    `Ошибки: ${result.errors}`,
    `Пропущено: ${result.skipped ?? 0}`,
    `Заблокировали бота: ${result.blocked}`
  ].filter(Boolean).join("\n");
}

function formatReleaseVersionLine(result) {
  const versionFrom = result.versionFrom ?? result.version ?? null;
  const versionTo = result.versionTo ?? result.version ?? null;
  if (!versionFrom && !versionTo) return null;
  if (!versionFrom || versionFrom === versionTo) {
    return `Версия: ${versionTo ?? versionFrom}`;
  }
  if (!versionTo) return `Версия: ${versionFrom}`;
  return `Версии: ${versionFrom} — ${versionTo}`;
}

async function transcribeVoice(message, voiceTranscriber, trace) {
  if (!voiceTranscriber?.isConfigured()) return null;
  const voice = message.voice ?? message.audio;
  if (!voice) return null;
  return voiceTranscriber.transcribeTelegramVoice(voice, {
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
}

async function sendExpenseProcessingMessage(token, chatId, language, telegramClient, trace) {
  try {
    const result = await sendTelegramResponse(trace, () => sendMessage(token, chatId, botText(language, "expenseProcessing"), null, telegramClient));
    return { messageId: extractMessageId(result) };
  } catch (error) {
    console.error("[telegram] failed to send expense processing loader", error.message);
    return { messageId: null };
  }
}

async function deliverResultMessage({ token, chatId, loaderMessageId, text, replyMarkup, telegramClient, trace }) {
  if (loaderMessageId) {
    try {
      return await sendTelegramResponse(trace, () => editMessageText(token, chatId, loaderMessageId, text, replyMarkup, telegramClient));
    } catch (error) {
      console.error("[telegram] editing loader into result failed, falling back to new message", error.message);
      await deleteMessage(token, chatId, loaderMessageId, telegramClient).catch((deleteError) => {
        console.error("[telegram] failed to delete loader after edit failure", deleteError.message);
      });
    }
  }
  return sendTelegramResponse(trace, () => sendMessage(token, chatId, text, replyMarkup, telegramClient));
}

function extractMessageId(sendResult) {
  return sendResult?.result?.message_id ?? sendResult?.message_id ?? null;
}

async function handleOnboardingMessage({ text, user, repository, token, chatId, miniAppUrl, telegramUserId, telegramClient, now, trace }) {
  const language = user.interface_language ?? "en";
  const step = user.onboarding_step ?? "completed";

  if (step === "language") {
    const selectedLanguage = parseLanguage(text);
    if (!selectedLanguage) {
      return sendTelegramResponse(trace, () => sendMessage(token, chatId, onboardingText(language, "languageRetry"), languageKeyboard(), telegramClient));
    }
    trace.start("db_save");
    await updateOnboardingLanguage(repository, telegramUserId, selectedLanguage);
    trace.end("db_save");
    return sendTelegramResponse(trace, () => sendMessage(token, chatId, onboardingText(selectedLanguage, "introBudgetSetup"), null, telegramClient));
  }

  if (step === "budget_setup") {
    return handleBudgetSetupMessage({ text, user, repository, token, chatId, miniAppUrl, telegramUserId, telegramClient, now, trace });
  }

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
    if (isSkip(text)) {
      trace.start("db_save");
      await repository.setOnboardingStep?.(telegramUserId, "completed");
      trace.end("db_save");
      return sendTelegramResponse(trace, () => sendMessage(token, chatId, onboardingText(language, "complete"), appKeyboard(miniAppUrl, telegramUserId, language), telegramClient));
    }
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
  return ONBOARDING_STEPS.includes(user?.onboarding_step);
}

async function handleBudgetSetupMessage({ text, user, repository, token, chatId, miniAppUrl, telegramUserId, telegramClient, now, trace }) {
  const language = user.interface_language ?? "en";
  const data = normalizeOnboardingData(user.onboarding_data);
  const currency = parseCurrencyFromText(text) ?? data.currency ?? null;
  const amount = parseSingleAmount(text, currency ?? user.base_currency ?? "THB");
  const monthlyBudgetAmount = amount?.amount ?? data.monthlyBudgetAmount ?? null;

  if (!currency && !monthlyBudgetAmount) {
    return sendTelegramResponse(trace, () => sendMessage(token, chatId, onboardingText(language, "budgetSetupRetry"), null, telegramClient));
  }

  if (!currency) {
    trace.start("db_save");
    await repository.updateOnboardingData?.(telegramUserId, { monthlyBudgetAmount });
    trace.end("db_save");
    return sendTelegramResponse(trace, () => sendMessage(token, chatId, onboardingText(language, "budgetSetupCurrencyMissing"), null, telegramClient));
  }

  if (!monthlyBudgetAmount || monthlyBudgetAmount <= 0) {
    trace.start("db_save");
    await repository.updateOnboardingData?.(telegramUserId, { currency });
    trace.end("db_save");
    return sendTelegramResponse(trace, () => sendMessage(token, chatId, onboardingText(language, "budgetSetupAmountMissing", { currency }), null, telegramClient));
  }

  const nextStep = localMonthDay(now()) > 5 ? "current_month_budget" : "completed";
  trace.start("db_save");
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
  trace.end("db_save");

  if (nextStep === "completed") {
    return sendTelegramResponse(trace, () => sendMessage(token, chatId, onboardingText(language, "complete"), appKeyboard(miniAppUrl, telegramUserId, language), telegramClient));
  }
  return sendTelegramResponse(trace, () => sendMessage(token, chatId, onboardingText(language, "currentMonthBudget", { currency }), null, telegramClient));
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
  return /^(0|skip|пропустить|нет|как обычно)$/iu.test(String(text ?? "").trim());
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
  return timezoneLocalMonthDay(now);
}

async function handleCallback({ update, repository, token, miniAppUrl, telegramClient, trace, now = () => new Date() }) {
  const callback = update.callback_query;
  const [action, draftId, itemIndex, value] = callback.data.split(":");
  const telegramUserId = callback.from.id;
  trace.start("user_context");
  const user = await repository.getUserByTelegramId?.(telegramUserId);
  trace.end("user_context");
  const language = user?.interface_language ?? "en";

  if (action === "daily_reminder") {
    return handleDailyReminderCallback({
      callback,
      action: draftId,
      user,
      telegramUserId,
      language,
      repository,
      token,
      telegramClient,
      trace,
      now
    });
  }

  if (action === "onboard_lang") {
    const selectedLanguage = ["en", "ru"].includes(draftId) ? draftId : "en";
    trace.start("db_save");
    await updateOnboardingLanguage(repository, telegramUserId, selectedLanguage);
    trace.end("db_save");
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, selectedLanguage === "ru" ? "Язык выбран" : "Language selected", telegramClient);
      return sendMessage(token, callback.message.chat.id, onboardingText(selectedLanguage, "introBudgetSetup"), null, telegramClient);
    });
  }

  if (action === "plan_confirm") {
    trace.start("db_save");
    await repository.confirmPlannedDraft(draftId, telegramUserId);
    trace.end("db_save");
    await safeRecordAppEvent(repository, user?.id, "expense_draft_confirmed", { draftType: "planned" });
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, botText(language, "savedCallback"), telegramClient);
      return sendMessage(token, callback.message.chat.id, botText(language, "plannedSaved"), appKeyboard(miniAppUrl, telegramUserId, language), telegramClient);
    });
  }

  if (action === "plan_cancel") {
    trace.start("db_save");
    await repository.cancelPlannedDraft(draftId, telegramUserId);
    trace.end("db_save");
    await safeRecordAppEvent(repository, user?.id, "expense_draft_cancelled", { draftType: "planned" });
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, botText(language, "cancelledCallback"), telegramClient);
      if (messageId) {
        try {
          return await editMessageText(token, chatId, messageId, botText(language, "plannedCancelMessage"), { inline_keyboard: [] }, telegramClient);
        } catch (error) {
          console.error("[telegram] editing cancelled planned draft failed, falling back to new message", error.message);
        }
      }
      return sendMessage(token, chatId, botText(language, "plannedCancelMessage"), null, telegramClient);
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
    await safeRecordAppEvent(repository, user?.id, "expense_draft_confirmed", { draftType: "regular" });
    for (const _expense of expenses) {
      await safeRecordAppEvent(repository, user?.id, "expense_saved", { draftType: "regular" });
    }
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;
    const text = formatSavedSummary(total, dashboard.snapshot, { language, expenses });
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, botText(language, "savedCallback"), telegramClient);
      if (messageId) {
        try {
          return await editMessageText(token, chatId, messageId, text, appKeyboard(miniAppUrl, telegramUserId, language), telegramClient);
        } catch (error) {
          console.error("[telegram] editing confirmed draft into summary failed, falling back to new message", error.message);
          await editMessageText(
            token,
            chatId,
            messageId,
            callback.message.text ?? botText(language, "savedCallback"),
            { inline_keyboard: [] },
            telegramClient
          ).catch((editError) => {
            console.error("[telegram] failed to remove draft keyboard after confirm edit failure", editError.message);
          });
        }
      }
      return sendMessage(token, chatId, text, appKeyboard(miniAppUrl, telegramUserId, language), telegramClient);
    });
  }

  if (action === "cancel") {
    trace.start("db_save");
    await repository.cancelDraft(draftId, telegramUserId);
    trace.end("db_save");
    await safeRecordAppEvent(repository, user?.id, "expense_draft_cancelled", { draftType: "regular" });
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, botText(language, "cancelledCallback"), telegramClient);
      if (messageId) {
        try {
          return await editMessageText(token, chatId, messageId, botText(language, "cancelDraftMessage"), { inline_keyboard: [] }, telegramClient);
        } catch (error) {
          console.error("[telegram] editing cancelled draft failed, falling back to new message", error.message);
        }
      }
      return sendMessage(token, chatId, botText(language, "cancelDraftMessage"), null, telegramClient);
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

async function handleDailyReminderCallback({ callback, action, user, telegramUserId, language, repository, token, telegramClient, trace, now }) {
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const normalized = normalizeTimeZone(user?.timezone);
  const timezoneUsed = normalized.timeZone;
  const localDate = timezoneLocalDateKey(now(), timezoneUsed);

  if (action === "add") {
    trace.start("db_save");
    await repository.recordAppEvent?.(user?.id ?? null, "daily_reminder_clicked_add", {
      local_date: localDate,
      clicked_at: now().toISOString()
    });
    trace.end("db_save");
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, language === "ru" ? "Напиши расход" : "Send an expense", telegramClient);
      return sendMessage(token, chatId, dailyReminderText(language, "addHint"), null, telegramClient);
    });
  }

  if (action === "no_spending") {
    trace.start("db_save");
    await repository.createNoSpendingMark?.(user.id, localDate, timezoneUsed);
    await repository.recordAppEvent?.(user.id, "daily_reminder_clicked_no_spending", {
      local_date: localDate,
      clicked_at: now().toISOString()
    });
    trace.end("db_save");
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, language === "ru" ? "Отмечено" : "Marked", telegramClient);
      return editMessageText(token, chatId, messageId, dailyReminderText(language, "noSpendingDone"), { inline_keyboard: [] }, telegramClient);
    });
  }

  if (action === "disable") {
    trace.start("db_save");
    await repository.setDailyEntryReminderEnabled?.(telegramUserId, false);
    await repository.recordAppEvent?.(user.id, "daily_reminder_disabled", {
      local_date: localDate,
      clicked_at: now().toISOString()
    });
    trace.end("db_save");
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, language === "ru" ? "Отключено" : "Disabled", telegramClient);
      return editMessageText(token, chatId, messageId, dailyReminderText(language, "disabledDone"), { inline_keyboard: [] }, telegramClient);
    });
  }

  return sendTelegramResponse(trace, async () => {
    await answerCallback(token, callback.id, botText(language, "openMiniAppCallback"), telegramClient);
    return sendMessage(token, chatId, botText(language, "editInMiniApp"), null, telegramClient);
  });
}

function dailyReminderText(language, key) {
  const ru = language === "ru";
  const messages = {
    addHint: ru
      ? "Напиши трату текстом или голосом — я добавлю."
      : "Send an expense by text or voice — I’ll add it.",
    noSpendingDone: ru
      ? "Отлично, отметил день без трат ✅"
      : "Done — marked today as no spending ✅",
    disabledDone: ru
      ? "Окей, больше не буду напоминать вечером."
      : "Okay, I won’t send evening reminders anymore."
  };
  return messages[key];
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
  const weekday = timezoneLocalWeekday(now);
  const hour = timezoneLocalHour(now);
  return weekday === 0 && hour >= 20;
}

function localDateKey(now) {
  return timezoneLocalDateKey(now);
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

let logMessageIdSequence = 0;
function nextLogMessageId() {
  logMessageIdSequence += 1;
  return logMessageIdSequence;
}

async function sendMessage(token, chatId, text, replyMarkup, telegramClient) {
  if (telegramClient) {
    return telegramClient.sendMessage({ chatId, text, replyMarkup });
  }
  if (!token) {
    const logMessageId = nextLogMessageId();
    console.log("[telegram:sendMessage]", { chatId, text, replyMarkup });
    return { ok: true, result: { message_id: logMessageId } };
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

export async function sendTelegramMessage({ token, chatId, text, replyMarkup = null, telegramClient = null }) {
  return sendMessage(token, chatId, text, replyMarkup, telegramClient);
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
  const initialMessageMetadata = messageMetadata(update, messageType);
  const starts = new Map();
  const durations = new Map();
  let queueWaitMs = null;
  let llmParseMetadata = {};
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
      durations.set(stage, (durations.get(stage) ?? 0) + durationMs);
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
    },

    getDurations() {
      return Object.fromEntries(durations.entries());
    },

    getMetadata() {
      return {
        queueWaitMs,
        llmParse: { ...llmParseMetadata },
        audioDurationSec: initialMessageMetadata.audioDurationSec
      };
    }
  };

  trace.event("message_received", initialMessageMetadata);
  return trace;

  function logStage(stage, durationMs, success, metadata = {}, error = null) {
    if (stage === "queue_job_start" && Number.isFinite(Number(metadata.queueWaitMs))) {
      queueWaitMs = Number(metadata.queueWaitMs);
    }
    if (stage === "llm_parse_start" || stage === "llm_parse_end") {
      llmParseMetadata = { ...llmParseMetadata, ...pickLlmMetadata(metadata) };
    }
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

function pickLlmMetadata(metadata) {
  return Object.fromEntries(
    Object.entries({
      model: metadata.model,
      promptChars: metadata.promptChars,
      responseChars: metadata.responseChars,
      fallback: metadata.fallback
    }).filter(([, value]) => value !== undefined)
  );
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
      language: "Choose language / Выбери язык:",
      languageRetry: "Please choose a language: English or Русский.",
      introBudgetSetup: [
        "Money Flow помогает заносить расходы текстом или голосом.",
        "Например: <b>кофе 70 бат и обед 180</b>.",
        "Сначала я покажу черновик, а сохраню только после подтверждения.",
        "",
        "Теперь отправь валюту и месячный бюджет одним сообщением: <b>THB 42000</b> или <b>USD 2000</b>."
      ].join("\n"),
      budgetSetupRetry: "Не понял валюту и месячный бюджет. Напиши, например: <b>THB 42000</b> или <b>USD 2000</b>.",
      budgetSetupCurrencyMissing: "Бюджет понял. Теперь отправь валюту: <b>THB</b>, <b>USD</b>, <b>RUB</b>, <b>IDR</b>, <b>EUR</b>, <b>BYN</b> или <b>GEL</b>.",
      budgetSetupAmountMissing: `Ок, считаем в <b>${currency}</b>. Теперь отправь месячный бюджет, например: <b>42000</b> или <b>42k</b>.`,
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

function botText(language, key, values = {}) {
  const lang = language === "ru" ? "ru" : "en";
  const messages = {
    ru: {
      queuedBehindPrevious: "Принял ещё одно сообщение. Сначала закончу предыдущий расход, потом обработаю это.",
      userQueueFull: "Я уже разбираю несколько твоих сообщений. Чтобы не перепутать расходы, дождись результата и отправь следующее чуть позже.",
      globalQueueDelayed: "Сейчас обработка может занять чуть больше времени. Я принял сообщение и разберу его по очереди.",
      globalQueueFull: "Сейчас обработка временно занята. Дождись, пожалуйста, результата по предыдущим сообщениям и отправь это ещё раз чуть позже.",
      jobProcessingFailed: "Не получилось обработать это сообщение. Попробуй отправить его ещё раз.",
      parseFailed: "Не получилось разобрать расход. Попробуй написать проще: <b>кофе 70 бат</b>.",
      transcriptionFailed: "Не смог разобрать голосовое. Попробуй ещё раз или напиши текстом: кофе 70 бат",
      amountNotFound: "Не нашел сумму. Напиши так: <b>кофе 70 бат</b>.",
      amountNotFoundWithTranscript: `Я услышал: «${formatTranscriptForTelegram(values.transcript)}». Но не нашёл сумму. Напиши, например: <b>кофе 70 бат</b>`,
      unsupportedPhoto: "Фото чеков пока не умею читать. Отправь расход текстом или голосом: кофе 70 бат",
      amountUpdatedCallback: "Сумма обновлена",
      cancelledCallback: "Отменено",
      cancelDraftMessage: "❌ Запись отменена",
      plannedCancelMessage: "❌ Плановая трата отменена",
      categoryUpdatedCallback: "Категория обновлена",
      draftCancelled: "Черновик отменен.",
      editInMiniApp: "Редактирование доступно в Mini App.",
      expenseProcessing: "⏳ Заношу расход…",
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
      technicalError: "⚠️ Что-то пошло не так. Попробуйте ещё раз.",
      unsupported: "Пока умею принимать только текстовые и голосовые расходы."
    },
    en: {
      queuedBehindPrevious: "Got one more message. I’ll finish the previous expense first, then process this one.",
      userQueueFull: "I’m already processing several of your messages. To avoid mixing up expenses, please wait for the result and send the next one a bit later.",
      globalQueueDelayed: "Processing may take a little longer right now. I’ve received your message and will handle it in order.",
      globalQueueFull: "Processing is temporarily busy right now. Please wait for the previous messages to finish and send this again a bit later.",
      jobProcessingFailed: "I couldn’t process this message. Please try sending it again.",
      parseFailed: "I couldn’t parse the expense. Try a simpler message: <b>coffee 70 baht</b>.",
      transcriptionFailed: "I couldn’t understand the voice message. Try again or type it: coffee 70 baht",
      amountNotFound: "I did not find an amount. Try: <b>coffee 70 baht</b>.",
      amountNotFoundWithTranscript: `I heard: “${formatTranscriptForTelegram(values.transcript)}”. But I couldn’t find an amount. Try: <b>coffee 70 baht</b>`,
      unsupportedPhoto: "I can’t read receipt photos yet. Send the expense by text or voice: coffee 70 baht",
      amountUpdatedCallback: "Amount updated",
      cancelledCallback: "Cancelled",
      cancelDraftMessage: "❌ Entry cancelled",
      plannedCancelMessage: "❌ Planned expense cancelled",
      categoryUpdatedCallback: "Category updated",
      draftCancelled: "Draft cancelled.",
      editInMiniApp: "Editing is available in Mini App.",
      expenseProcessing: "⏳ Adding expense…",
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
      technicalError: "⚠️ Something went wrong. Please try again.",
      unsupported: "For now I can accept only text and voice expenses."
    }
  };
  return messages[lang][key];
}

function formatTranscriptForTelegram(transcript) {
  return escapeTelegramHtml(truncateText(String(transcript ?? "").trim(), 140));
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function escapeTelegramHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
