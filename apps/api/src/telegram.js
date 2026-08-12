import { createExpenseParser } from "./expenseParser.js";
import { parseExpenseText } from "../../../packages/shared/src/parser.js";
import { parseBudgetTopupText } from "../../../packages/shared/src/budgetTopupParser.js";
import { parsePlannedExpenseText } from "../../../packages/shared/src/plannedParser.js";
import { normalizeCurrency, SUPPORTED_CURRENCY_CODES } from "../../../packages/shared/src/currencies.js";
import { isAdminTelegramId, parseBotCommand } from "./adminAccess.js";
import {
  localDateKey as timezoneLocalDateKey,
  localHour as timezoneLocalHour,
  localMonthDay as timezoneLocalMonthDay,
  localWeekday as timezoneLocalWeekday,
  normalizeTimeZone
} from "../../../packages/shared/src/time.js";
import { localDateTimeToUtc } from "../../../packages/shared/src/time.js";
import { formatAdminMessageParts } from "./adminStatsService.js";
import { renderAdminRichMessage } from "./adminRichMessage.js";
import { formatProductStatsSections } from "./productStatsService.js";
import { formatTechnicalStatsSections } from "./technicalStatsService.js";
import { createExpenseExportService } from "./expenseExportService.js";
import { createExpenseDraftFromText, ExpenseTextNotRecognizedError } from "./expenseDraftService.js";
import { createTelegramJobQueue } from "./telegramJobQueue.js";
import { renderDraftPreview } from "./draftPreview.js";
import { formatPlannedPaymentReminder } from "./plannedPaymentReminderService.js";
import { formatBudgetTopupDraft, formatBudgetTopupSuccess, formatBudgetTopupUndoSuccess, formatPlannedDraft, formatReserveClosedEvent, formatSavedSummary, formatTotals, formatWeeklyReport } from "./telegramFormat.js";
import {
  appKeyboard,
  budgetTopupDraftKeyboard,
  budgetTopupMiniAppKeyboard,
  budgetTopupSuccessKeyboard,
  categorySlugFromCode,
  draftKeyboard,
  inboxDraftKeyboard,
  parseBudgetTopupCallback,
  parseDraftCallback,
  plannedDraftKeyboard,
  plannedPaymentDisableConfirmationKeyboard,
  plannedPaymentReminderKeyboard,
  plannedPaymentSuccessKeyboard,
  savedExpenseKeyboard
} from "./telegramKeyboards.js";
import { DraftCanceledError, CategoryRequiredError } from "./repository.js";
import { normalizeAcquisitionSource } from "./productAnalytics.js";
import { parseEditorText } from "./telegramExpenseInput.js";
import {
  applyDraftEditorChange,
  applySavedExpenseEditorChange,
  editorTargetKey,
  editorMessageForCode,
  expenseCategoryKeyboard,
  expenseDateKeyboard,
  expenseDeleteKeyboard,
  expenseEditorKeyboard,
  expenseInputPrompt,
  expenseTreatmentKeyboard,
  formatExpenseEditor,
  parseExpenseEditorCallback,
  prepareSavedExpenseEditorChange
} from "./telegramExpenseEditor.js";

// budget_setup is the primary onboarding path; base_currency/monthly_budget/month_opening_spend are legacy fallback states.
const ONBOARDING_STEPS = ["language", "budget_setup", "base_currency", "monthly_budget", "current_month_budget", "month_opening_spend"];
const FEEDBACK_PENDING_TTL_MS = 30 * 60_000;
const MIN_FEEDBACK_MESSAGE_LENGTH = 3;
const RICH_MESSAGE_MAX_LENGTH = 32768;
const EXPENSE_PROCESSING_CUSTOM_EMOJI_ID = "6003518287214808258";
const pendingFeedbackByTelegramUser = new Map();
const ACCOUNT_DELETION_SOURCE_TELEGRAM = "telegram";

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
  adminAlertService,
  expenseExportService,
  now = () => new Date(),
  telegramJobQueueOptions = {},
  telegramJobQueue = createTelegramJobQueue(telegramJobQueueOptions),
  awaitQueuedJobs = true
}) {
  const sharedExpenseExportService = expenseExportService ?? createExpenseExportService({
    repository,
    now,
    sendDocument: (document) => sendTelegramDocument({ token, telegramClient, ...document })
  });

  return {
    async handleUpdate(update) {
      const trace = createPerfTrace({ update, logger: perfLogger });
      let success = false;
      if (update.my_chat_member) {
        await handleMyChatMember({ update, repository, now });
        trace.finish(true);
        return { ok: true };
      }
      if (update.message) {
        try {
          const result = await handleMessage({ update, repository, token, miniAppUrl, expenseParser, voiceTranscriber, telegramClient, adminTelegramIds, adminStatsService, releaseNotesService, adminAlertService, expenseExportService: sharedExpenseExportService, now, trace, telegramJobQueue, awaitQueuedJobs });
          success = !result?.queued;
          return result;
        } catch (error) {
          await safeNotifyAdminError(adminAlertService, error, telegramAlertContext(update, "handle_update"));
          trace.finish(false, error);
          throw error;
        } finally {
          if (success) trace.finish(true);
        }
      }
      if (update.callback_query) {
        try {
          const result = await handleCallback({ update, repository, token, miniAppUrl, telegramClient, adminAlertService, expenseExportService: sharedExpenseExportService, trace, now });
          success = true;
          return result;
        } catch (error) {
          await safeNotifyAdminError(adminAlertService, error, telegramAlertContext(update, "handle_callback"));
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

async function handleMessage({ update, repository, token, miniAppUrl, expenseParser, voiceTranscriber, telegramClient, adminTelegramIds, adminStatsService, releaseNotesService, adminAlertService, expenseExportService, now, trace, telegramJobQueue, awaitQueuedJobs }) {
  const message = update.message;
  const from = message.from;
  if (!from) return { ok: true };

  const rawText = message.text?.trim() || null;
  const parsedCommand = parseBotCommand(rawText);
  const commandText = parsedCommand.command;
  const acquisitionSource = commandText === "/start"
    ? normalizeAcquisitionSource(parsedCommand.payload)
    : "direct";

  trace.start("user_context");
  const user = await repository.upsertTelegramUser({
    id: from.id,
    firstName: from.first_name,
    username: from.username,
    acquisitionSource,
    acquisitionSeenAt: now()
  });
  trace.end("user_context");
  await repository.clearTelegramUserBotBlocked?.(from.id, {
    source: "incoming_message",
    now: now()
  });
  const language = user.interface_language ?? "en";
  const chatId = message.chat.id;

  const editorRoute = await routeTelegramExpenseInput({
    message, rawText, hasVoice: Boolean(message.voice || message.audio), hasPhoto: Boolean(message.photo?.length),
    commandText, user, repository, telegramUserId: from.id, language, now: now(), token, telegramClient
  });
  if (editorRoute) return sendTelegramResponse(trace, () => editorRoute);

  const feedbackCommand = parseFeedbackCommand(rawText);
  const hasVoice = Boolean(message.voice || message.audio);
  const hasPhoto = Boolean(message.photo?.length);
  const restartsAccountDeletion = commandText === "/delete_me" && !hasVoice && !hasPhoto;

  if (!restartsAccountDeletion) {
    const currentNow = now();
    const pendingDeletion = await repository.getPendingAccountDeletion?.(from.id, {
      source: ACCOUNT_DELETION_SOURCE_TELEGRAM,
      now: currentNow
    });
    if (pendingDeletion?.stage === "awaiting_text") {
      if (rawText === "DELETE" && !hasVoice && !hasPhoto) {
        try {
          await repository.confirmAccountDeletion({
            telegramUserId: from.id,
            source: ACCOUNT_DELETION_SOURCE_TELEGRAM,
            confirmationText: rawText,
            now: currentNow
          });
        } catch (error) {
          if (isAccountDeletionPendingGone(error)) {
            return sendTelegramResponse(trace, () => sendMessage(token, chatId, accountDeletionText(language, "expired"), null, telegramClient));
          }
          throw error;
        }
        return sendTelegramResponse(trace, async () => {
          try {
            return await sendMessage(token, chatId, accountDeletionText(language, "deleted"), null, telegramClient);
          } catch {
            console.error("[telegram] failed to send account deletion completion message");
            return { ok: true };
          }
        });
      }
      return sendTelegramResponse(trace, () => sendMessage(token, chatId, accountDeletionText(language, "retry"), null, telegramClient));
    }
  }

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

    if (commandText === "/admin_stats" || commandText === "/admin_stats_tech") {
      if (!isAdminTelegramId(from.id, adminTelegramIds)) {
        console.warn("[admin] access denied", {
          command: commandText,
          fromId: from.id,
          username: from.username ?? null,
          chatId,
          adminIdsCount: adminTelegramIds.size,
          adminEnvConfigured: adminTelegramIds.size > 0
        });
        return sendTelegramResponse(trace, () => sendMessage(token, chatId, "Access denied", null, telegramClient));
      }
      const technical = commandText === "/admin_stats_tech";
      const method = technical ? "getTechnicalStats" : "getAdminStats";
      const unavailable = technical ? "Technical stats unavailable" : "Product stats unavailable";
      if (typeof adminStatsService?.[method] !== "function") return sendTelegramResponse(trace, () => sendMessage(token, chatId, unavailable, null, telegramClient));
      try {
        const stats = await adminStatsService[method]();
        const sections = technical ? formatTechnicalStatsSections(stats) : formatProductStatsSections(stats);
        return await sendAdminStatsMessage({
          token,
          chatId,
          sections,
          command: commandText,
          reportType: technical ? "technical" : "product",
          telegramClient
        });
      } catch (error) {
        if (error instanceof AmbiguousAdminRichMessageError) throw error;
        console.error("[telegram] admin stats failed", error);
        return sendTelegramResponse(trace, () => sendMessage(token, chatId, unavailable, null, telegramClient));
      }
    }

    if (commandText === "/start") {
      await safeRecordAppEvent(repository, user.id, "bot_started", { source: acquisitionSource });
      if (isOnboardingActive(user)) {
        const response = await sendTelegramResponse(trace, () => sendMessage(token, chatId, onboardingPrompt(user), onboardingReplyMarkup(user), telegramClient));
        await safeRecordAppEventOnce(repository, user.id, "onboarding_started", { source: "telegram" });
        return response;
      }
      return sendTelegramResponse(trace, () => sendMessage(token, chatId, botText(language, "start"), appKeyboard(miniAppUrl, from.id, language), telegramClient));
    }

    if (feedbackCommand) {
      if (feedbackCommand.feedbackText) {
        const result = await saveFeedbackMessage({
          feedbackText: feedbackCommand.feedbackText,
          repository,
          user,
          telegramUserId: from.id,
          chatId,
          token,
          telegramClient,
          adminTelegramIds,
          trace,
          language
        });
        if (!result.saved) setPendingFeedback(from.id, now());
        return result.response;
      }
      setPendingFeedback(from.id, now());
      return sendTelegramResponse(trace, () => sendMessage(token, chatId, feedbackPromptText(language), null, telegramClient));
    }

    if (commandText === "/delete_me") {
      await repository.requestAccountDeletion(from.id, { source: ACCOUNT_DELETION_SOURCE_TELEGRAM });
      return sendTelegramResponse(trace, () => sendMessage(token, chatId, accountDeletionText(language, "warning"), accountDeletionButtons(language, "requested"), telegramClient));
    }

    if (commandText === "/export") {
      return sendTelegramResponse(trace, () => sendMessage(token, chatId, botText(language, "exportChoosePeriod"), exportPeriodKeyboard(language), telegramClient));
    }

    if (commandText === "/last") {
      const expense = await repository.getLatestEditableExpenseForTelegramUser?.(from.id);
      if (!expense) return sendTelegramResponse(trace, () => sendMessage(token, chatId, language === "ru" ? "Сохранённых расходов пока нет." : "No saved expenses yet.", null, telegramClient));
      const dashboard = await repository.dashboard(from.id);
      return sendTelegramResponse(trace, () => sendMessage(
        token, chatId, formatSavedSummary(Number(expense.amount_base), dashboard.snapshot, { language, expenses: [expense] }),
        savedExpenseKeyboard(expense.id, miniAppUrl, from.id, language), telegramClient
      ));
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
    run: () => processQueuedMessage({ message, from, user, rawText, hasVoice, inputType: trackExpenseMessage ? inputType : null, repository, token, miniAppUrl, expenseParser, voiceTranscriber, telegramClient, adminTelegramIds, adminAlertService, now, trace }),
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
      await sendQueuedJobFailure({ error, token, chatId, language, telegramClient, adminAlertService, telegramUserId: from.id, userId: user.id, trace });
    }
    return { ok: true };
  }

  queued.promise
    .then(() => trace.finish(true))
    .catch(async (error) => {
      await sendQueuedJobFailure({ error, token, chatId, language, telegramClient, adminAlertService, telegramUserId: from.id, userId: user.id, trace });
      trace.finish(false, error);
    });
  return { ok: true, queued: true };
}

async function sendQueuedJobFailure({ error, token, chatId, language, telegramClient, adminAlertService, telegramUserId, userId, trace }) {
  trace.failActive(["telegram_file_download", "transcription", "llm_parse", "db_save"], error);
  console.error("[telegram] queued job failed", error.message);
  if (!error?.adminAlertSent) {
    await safeNotifyAdminError(adminAlertService, error, {
      source: "telegram",
      operation: "queued_job",
      telegramUserId,
      userId
    });
  }
  try {
    await sendTelegramResponse(trace, () => sendMessage(token, chatId, botText(language, "jobProcessingFailed"), null, telegramClient));
  } catch (sendError) {
    console.error("[telegram] failed to send queued job failure message", sendError.message);
  }
}

function setPendingFeedback(telegramUserId, now = new Date()) {
  const currentTime = new Date(now).getTime();
  pruneExpiredPendingFeedback(currentTime);
  pendingFeedbackByTelegramUser.set(Number(telegramUserId), {
    expiresAt: currentTime + FEEDBACK_PENDING_TTL_MS
  });
}

function clearPendingFeedback(telegramUserId) {
  pendingFeedbackByTelegramUser.delete(Number(telegramUserId));
}

function isFeedbackPending(telegramUserId, now = new Date()) {
  const key = Number(telegramUserId);
  const pending = pendingFeedbackByTelegramUser.get(key);
  if (!pending) return false;
  if (pending.expiresAt <= new Date(now).getTime()) {
    pendingFeedbackByTelegramUser.delete(key);
    return false;
  }
  return true;
}

function parseFeedbackCommand(rawText) {
  if (!rawText) return null;
  const match = String(rawText).trim().match(/^\/feedback(?:@[a-z0-9_]+)?(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  return { feedbackText: String(match[1] ?? "").trim() };
}

function pruneExpiredPendingFeedback(currentTime) {
  for (const [telegramUserId, pending] of pendingFeedbackByTelegramUser) {
    if (pending.expiresAt <= currentTime) pendingFeedbackByTelegramUser.delete(telegramUserId);
  }
}

export async function processQueuedMessage({ message, from, user, rawText, hasVoice, inputType, repository, token, miniAppUrl, expenseParser, voiceTranscriber, telegramClient, adminTelegramIds = new Set(), adminAlertService, now = () => new Date(), trace }) {
  const processingStartedAt = performance.now();
  const language = user.interface_language ?? "en";
  const chatId = message.chat.id;
  let processingResult = inputType ? "processing_failed" : undefined;
  let processingDraftType;
  let processingParserRoute;
  let transcriptChars = null;

  try {
    if (rawText && isFeedbackPending(from.id, now())) {
      const feedbackText = rawText.trim();
      const result = await saveFeedbackMessage({ feedbackText, repository, user, telegramUserId: from.id, chatId, token, telegramClient, adminTelegramIds, trace, language });
      processingResult = result.processingResult;
      if (result.saved) clearPendingFeedback(from.id);
      return result.response;
    }

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

    const loader = await sendExpenseProcessingMessage(token, chatId, language, telegramClient, trace, message.message_id);
    try {
      let text = rawText;
      if (!text && hasVoice) {
        try {
          text = await transcribeVoice(message, voiceTranscriber, trace);
          transcriptChars = String(text ?? "").length;
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

      const topupParsed = parseBudgetTopupText(text, {
        now: now(),
        defaultCurrency: user.base_currency ?? "THB",
        timeZone: user.timezone
      });
      if (topupParsed.state === "failed") {
        processingResult = "budget_topup_parse_failed";
        await safeRecordAppEvent(repository, user.id, "budget_topup_parse_failed", { inputType });
        return deliverResultMessage({
          token,
          chatId,
          loaderMessageId: loader.messageId,
          text: botText(language, "budgetTopupParseFailed"),
          replyMarkup: null,
          telegramClient,
          trace
        });
      }
      if (topupParsed.state === "recognized") {
        trace.start("db_save");
        const preview = await repository.previewBudgetTopup(user.id, topupParsed.item, now());
        const draft = await repository.createBudgetTopupDraft(user.id, text, topupParsed.item, now());
        trace.end("db_save");
        const large = preview.large === true;
        await safeRecordAppEvent(repository, user.id, "budget_topup_draft_created", {
          inputType,
          kind: topupParsed.item.kind,
          currency: topupParsed.item.currency,
          amountBase: preview.amountBase,
          baseBudget: preview.baseBudget,
          largeAmountConfirmation: large
        });
        processingResult = "budget_topup_draft_created";
        processingDraftType = "budget_topup";
        return deliverResultMessage({
          token,
          chatId,
          loaderMessageId: loader.messageId,
          text: formatBudgetTopupDraft(topupParsed.item, { language, large }),
          replyMarkup: budgetTopupDraftKeyboard(draft.id, language, { large }),
          telegramClient,
          trace
        });
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
        await safeNotifyAdminError(adminAlertService, error, {
          source: "parser",
          operation: "planned_parse",
          telegramUserId: from.id,
          userId: user.id
        });
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

      if (looksLikeNonExpenseIntent(text)) {
        processingResult = "unsupported_intent_message";
        processingParserRoute = "non_expense_guard";
        return deliverResultMessage({
          token,
          chatId,
          loaderMessageId: loader.messageId,
          text: nonExpenseGuardText(text),
          replyMarkup: null,
          telegramClient,
          trace
        });
      }

      let llmMetadata = {
        model: expenseParser.model,
        promptChars: String(text ?? "").length
      };
      trace.start("llm_parse", llmMetadata);
      let created;
      try {
        created = await createExpenseDraftFromText({
          user, text, source: "telegram", expenseParser, repository,
          parserOptions: {
          userId: from.id,
          onLlmTrace(metadata) {
            llmMetadata = { ...llmMetadata, ...metadata };
          }
          }
          ,onBeforePersist() { trace.start("db_save"); }
          ,onAfterPersist() { trace.end("db_save"); }
        });
      } catch (error) {
        if (error instanceof ExpenseTextNotRecognizedError) {
          processingResult = "amount_not_found";
          await safeRecordAppEvent(repository, user.id, "expense_parse_failed", { inputType });
          return deliverResultMessage({ token, chatId, loaderMessageId: loader.messageId,
            text: inputType === "voice" && text ? botText(language, "amountNotFoundWithTranscript", { transcript: text }) : botText(language, "amountNotFound"),
            replyMarkup: null, telegramClient, trace });
        }
        processingResult = error.expenseDraftStage === "persist" ? "draft_persist_failed" : "parser_failed";
        if (error.expenseDraftStage !== "persist") await safeRecordAppEvent(repository, user.id, "expense_parse_failed", { inputType });
        await safeNotifyAdminError(adminAlertService, error, {
          source: "parser",
          operation: "expense_parse",
          telegramUserId: from.id,
          userId: user.id
        });
        throw error;
      }
      trace.end("llm_parse", llmMetadata);
      const draft = created;
      await safeRecordAppEvent(repository, user.id, "expense_draft_created", { inputType, draftType: "regular" });
      processingResult = "draft_created";
      processingDraftType = "regular";
      const delivered = await deliverResultMessage({
        token,
        chatId,
        loaderMessageId: loader.messageId,
        text: await renderDraftPreview({ repository, user, items: draft.items, language }),
        replyMarkup: draftKeyboard(draft.id, draft.items, miniAppUrl, from.id, language),
        telegramClient,
        trace
      });
      const refMessageId = extractMessageId(delivered);
      if (refMessageId) {
        await repository.setDraftMessageRef(draft.id, from.id, chatId, refMessageId)
          .catch((error) => console.error("[telegram] failed to store draft message reference", error.message));
      }
      return delivered;
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
        parserEngine: traceMetadata.llmParse?.parserEngine,
        parserRoute: processingParserRoute ?? traceMetadata.llmParse?.parserRoute,
        fallbackReason: traceMetadata.llmParse?.fallbackReason,
        localFastPathAccepted: traceMetadata.llmParse?.localFastPathAccepted,
        localFastPathRejectReason: traceMetadata.llmParse?.localFastPathRejectReason,
        categoryResolution: traceMetadata.llmParse?.categoryResolution,
        localAcceptanceLevel: traceMetadata.llmParse?.localAcceptanceLevel,
        localCandidate: traceMetadata.llmParse?.localCandidate,
        llmSkipped: traceMetadata.llmParse?.llmSkipped,
        fastPathMode: traceMetadata.llmParse?.fastPathMode,
        shadowDisagreement: traceMetadata.llmParse?.shadowDisagreement,
        criticalShadowDisagreement: traceMetadata.llmParse?.criticalShadowDisagreement,
        categoryOnlyShadowDisagreement: traceMetadata.llmParse?.categoryOnlyShadowDisagreement,
        shadowDisagreementFields: traceMetadata.llmParse?.shadowDisagreementFields,
        localParseMs: traceMetadata.llmParse?.localParseMs,
        localEvaluateMs: traceMetadata.llmParse?.localEvaluateMs,
        llmHttpMs: traceMetadata.llmParse?.llmHttpMs,
        llmDecodeNormalizeMs: traceMetadata.llmParse?.llmDecodeNormalizeMs,
        parserTotalMs: traceMetadata.llmParse?.parserTotalMs,
        transcriptChars,
        audioDurationSec: inputType === "voice" ? traceMetadata.audioDurationSec : undefined
      });
    }
  }
}

async function saveFeedbackMessage({ feedbackText, repository, user, telegramUserId, chatId, token, telegramClient, adminTelegramIds, trace, language }) {
  if (feedbackText.length < MIN_FEEDBACK_MESSAGE_LENGTH) {
    return {
      saved: false,
      processingResult: "feedback_too_short",
      response: await sendTelegramResponse(trace, () => sendMessage(token, chatId, feedbackTooShortText(language), null, telegramClient))
    };
  }

  trace.start("db_save");
  const feedback = await repository.createFeedback({
    userId: user.id,
    telegramUserId,
    message: feedbackText,
    source: "bot",
    status: "new"
  });
  trace.end("db_save");
  await sendTelegramResponse(trace, () => sendMessage(token, chatId, feedbackAcceptedText(language), null, telegramClient));
  await notifyAdminFeedback({
    token,
    adminTelegramIds,
    telegramClient,
    feedback,
    fallback: {
      userId: user.id,
      telegramUserId,
      message: feedbackText,
      source: "bot"
    }
  });
  return { saved: true, processingResult: "feedback_saved", response: { ok: true } };
}

async function notifyAdminFeedback({ token, adminTelegramIds, telegramClient, feedback, fallback }) {
  if (!(adminTelegramIds instanceof Set) || adminTelegramIds.size === 0) return;
  const text = formatAdminFeedbackMessage(feedback, fallback);
  for (const chatId of adminTelegramIds) {
    try {
      await sendMessage(token, chatId, text, null, telegramClient);
    } catch (error) {
      console.error("[telegram] admin feedback notification failed", {
        chatId,
        message: error.message
      });
    }
  }
}

function formatAdminFeedbackMessage(feedback = {}, fallback = {}) {
  const userId = feedback.user_id ?? feedback.userId ?? fallback.userId ?? "unknown";
  const telegramUserId = feedback.telegram_user_id ?? feedback.telegramUserId ?? fallback.telegramUserId ?? "unknown";
  const source = feedback.source ?? fallback.source ?? "bot";
  const message = safeFeedbackMessage(feedback.message ?? fallback.message ?? "");
  return [
    "New feedback",
    "",
    `userId: ${userId}`,
    `telegramUserId: ${telegramUserId}`,
    `source: ${source}`,
    "",
    "Message:",
    message
  ].join("\n");
}

function safeFeedbackMessage(message) {
  const text = String(message ?? "").trim();
  return text.length <= 700 ? text : `${text.slice(0, 697).trimEnd()}...`;
}

function feedbackPromptText(language) {
  if (language === "ru") {
    return "Напиши одним сообщением, что не работает, что неудобно или чего не хватает. Я передам это разработчику.";
  }
  return "Write one message with what does not work, what is inconvenient, or what is missing. I will pass it to the developer.";
}

function feedbackAcceptedText(language) {
  if (language === "ru") {
    return "Спасибо! Я получил feedback и передал его разработчику.";
  }
  return "Thank you! I received your feedback and passed it to the developer.";
}

function feedbackTooShortText(language) {
  if (language === "ru") {
    return "Напиши, пожалуйста, чуть подробнее одним сообщением.";
  }
  return "Please write a little more detail in one message.";
}

function accountDeletionButtons(language, stage = "requested") {
  const cancelText = language === "ru" ? "Отмена" : "Cancel";
  if (stage === "awaiting_text") {
    return { inline_keyboard: [[{ text: cancelText, callback_data: "delete_me:cancel" }]] };
  }
  return {
    inline_keyboard: [[
      { text: language === "ru" ? "Продолжить" : "Continue", callback_data: "delete_me:advance" },
      { text: cancelText, callback_data: "delete_me:cancel" }
    ]]
  };
}

function accountDeletionText(language, key) {
  const messages = language === "ru" ? {
    warning: "Это безвозвратно удалит ваши данные Money Flow. Продолжайте, только если вы уверены.",
    promptDelete: "Последний шаг: введите DELETE в этом чате, чтобы навсегда удалить данные.",
    cancelled: "Удаление аккаунта отменено. Ничего не удалено.",
    deleted: "Ваши данные Money Flow удалены.",
    expired: "Запрос на удаление истёк или уже не активен. Используйте /delete_me, чтобы начать заново.",
    expiredCallback: "Запрос на удаление истёк.",
    retry: "Введите DELETE для подтверждения или /delete_me, чтобы начать заново."
  } : {
    warning: "This permanently deletes your Money Flow data. Continue only if you are sure.",
    promptDelete: "Final step: type DELETE in this chat to permanently delete your data.",
    cancelled: "Account deletion cancelled. Nothing was deleted.",
    deleted: "Your Money Flow data has been deleted.",
    expired: "Account deletion request expired or is no longer pending. Use /delete_me to start again.",
    expiredCallback: "Account deletion request expired.",
    retry: "Type DELETE to confirm or /delete_me to start again."
  };
  return messages[key];
}

function isAccountDeletionPendingGone(error) {
  return error?.code === "account_deletion_not_pending" || error?.code === "account_deletion_expired";
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

async function handleMyChatMember({ update, repository, now }) {
  const memberUpdate = update.my_chat_member;
  if (memberUpdate?.chat?.type !== "private") return;
  const oldAvailable = telegramMemberIsAvailable(memberUpdate.old_chat_member);
  const newAvailable = telegramMemberIsAvailable(memberUpdate.new_chat_member);
  if (oldAvailable === newAvailable || newAvailable == null) return;
  await repository.setTelegramUserBotBlocked?.(memberUpdate.chat.id, {
    blocked: !newAvailable,
    source: "telegram_status",
    now: now()
  });
}

function telegramMemberIsAvailable(member) {
  const status = member?.status;
  if (["creator", "administrator", "member"].includes(status)) return true;
  if (status === "restricted") return member?.is_member !== false;
  if (["left", "kicked"].includes(status)) return false;
  return null;
}

async function safeRecordAppEventOnce(repository, userId, eventName, metadata = {}) {
  try {
    await repository.recordAppEventOnce?.(userId, eventName, metadata);
  } catch (error) {
    console.warn("[events] record failed", {
      userId: userId ?? null,
      eventName,
      message: error.message
    });
  }
}

async function safeNotifyAdminError(adminAlertService, error, context) {
  if (typeof adminAlertService?.notifyAdminError !== "function") return;
  try {
    await adminAlertService.notifyAdminError(error, context);
    markAdminAlertSent(error);
  } catch (alertError) {
    console.error("[telegram] admin alert failed", alertError.message);
  }
}

function markAdminAlertSent(error) {
  if (error == null || (typeof error !== "object" && typeof error !== "function")) return;
  try {
    Object.defineProperty(error, "adminAlertSent", {
      value: true,
      configurable: true
    });
  } catch {
    error.adminAlertSent = true;
  }
}

function telegramAlertContext(update, operation) {
  const message = update?.message ?? update?.callback_query?.message ?? {};
  const from = update?.message?.from ?? update?.callback_query?.from ?? {};
  return {
    source: "telegram",
    operation,
    telegramUserId: from.id,
    extra: {
      chatId: message.chat?.id ?? null
    }
  };
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
  if (!result.sent && result.reason === "no_active_release_push_users") {
    return sendTelegramResponse(trace, () => sendMessage(token, chatId, "Нет активных пользователей для release push — digest не был отправлен.", null, telegramClient));
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

async function sendExpenseProcessingMessage(token, chatId, language, telegramClient, trace, sourceMessageId) {
  try {
    const replyParameters = sourceMessageId == null ? null : {
      message_id: sourceMessageId,
      allow_sending_without_reply: true
    };
    const result = await sendTelegramResponse(trace, () => sendMessage(
      token,
      chatId,
      botText(language, "expenseProcessing"),
      null,
      telegramClient,
      null,
      { replyParameters, retryPlainText: false }
    ));
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
    await safeRecordAppEventOnce(repository, user.id, "currency_selected", { currency });
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
    await safeRecordAppEventOnce(repository, user.id, "budget_set", {
      currency: user.base_currency ?? "THB",
      budgetType: "monthly"
    });
    if (nextStep === "completed") {
      await repository.setOnboardingStep?.(telegramUserId, "completed");
      trace.end("db_save");
      await safeRecordAppEventOnce(repository, user.id, "onboarding_completed");
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
      await safeRecordAppEventOnce(repository, user.id, "onboarding_completed");
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
    await safeRecordAppEventOnce(repository, user.id, "onboarding_completed");
    return sendTelegramResponse(trace, () => sendMessage(token, chatId, onboardingText(language, "complete"), appKeyboard(miniAppUrl, telegramUserId, language), telegramClient));
  }

  trace.start("db_save");
  await repository.setOnboardingStep?.(telegramUserId, "completed");
  trace.end("db_save");
  await safeRecordAppEventOnce(repository, user.id, "onboarding_completed");
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
  await safeRecordAppEventOnce(repository, user.id, "currency_selected", { currency });
  await safeRecordAppEventOnce(repository, user.id, "budget_set", {
    currency,
    budgetType: "monthly"
  });

  if (nextStep === "completed") {
    await safeRecordAppEventOnce(repository, user.id, "onboarding_completed");
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

function exportPeriodKeyboard(language) {
  const text = language === "ru"
    ? { month: "Текущий месяц", all: "Все время" }
    : { month: "Current month", all: "All time" };
  return {
    inline_keyboard: [
      [{ text: text.month, callback_data: "export:month" }],
      [{ text: text.all, callback_data: "export:all" }]
    ]
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

function editorCalendarDate(now, timeZone, dayOffset) {
  const parts = {};
  const safeTimeZone = normalizeTimeZone(timeZone).timeZone;
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(now)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset));
  return localDateTimeToUtc({
    year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: parts.hour, minute: parts.minute
  }, safeTimeZone);
}

function inlineEditorCancelKeyboard(target, language, sessionId) {
  return {
    inline_keyboard: [[{
      text: language === "ru" ? "↩ Отмена" : "↩ Cancel",
      callback_data: `ee:${editorTargetKey(target)}:cancel:${sessionId}`
    }]]
  };
}

function editorTargetRef(target, sessionId = null) {
  const reference = {
    targetType: target.type,
    targetId: target.id,
    itemIndex: target.type === "draft" ? target.itemIndex : null
  };
  if (sessionId != null) reference.sessionId = Number(sessionId);
  return reference;
}

function telegramMessageId(result) {
  const value = result?.result?.message_id ?? result?.message_id ?? null;
  return Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
}

async function deactivateTelegramEditorMessages({ session, fallbackChatId, fallbackMessageId, fallbackPromptMessageId, includeEditor = true, token, telegramClient }) {
  const chatId = session?.chat_id ?? fallbackChatId;
  const messageIds = [
    session?.prompt_message_id ?? fallbackPromptMessageId,
    includeEditor ? (session?.message_id ?? fallbackMessageId) : null
  ].filter((id, index, all) => Number.isSafeInteger(Number(id)) && Number(id) > 0 && all.indexOf(id) === index);

  for (const messageId of messageIds) {
    try {
      await deleteMessage(token, chatId, messageId, telegramClient);
    } catch (error) {
      console.error("[telegram] editor message removal failed; clearing keyboard instead", error.message);
      await editMessageReplyMarkup(token, chatId, messageId, { inline_keyboard: [] }, telegramClient)
        .catch((markupError) => console.error("[telegram] editor keyboard cleanup failed", markupError.message));
    }
  }
}

async function startTelegramEditorTextInput({ repository, telegramUserId, target, field, callback, language, now, token, telegramClient }) {
  const started = await repository.startTelegramInputSession(telegramUserId, {
    targetType: target.type,
    targetId: target.id,
    itemIndex: target.type === "draft" ? target.itemIndex : null,
    field,
    chatId: callback.message.chat.id,
    messageId: callback.message.message_id,
    language
  }, now());
  if (started?.outcome !== "started") return started;
  await deactivateTelegramEditorMessages({
    session: started.replacedSession,
    fallbackChatId: callback.message.chat.id,
    includeEditor: false,
    token,
    telegramClient
  });
  const sessionId = Number(started.session?.id);
  let promptMessageId = null;
  try {
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0 || !repository.setTelegramInputSessionPrompt) {
      throw new Error("telegram_editor_session_setup_failed");
    }
    const prompt = await sendMessage(
      token,
      callback.message.chat.id,
      expenseInputPrompt(field, { language }),
      inlineEditorCancelKeyboard(target, language, sessionId),
      telegramClient
    );
    promptMessageId = telegramMessageId(prompt);
    if (!promptMessageId) throw new Error("telegram_editor_prompt_missing_message_id");
    const stored = await repository.setTelegramInputSessionPrompt(telegramUserId, sessionId, {
      ...editorTargetRef(target, sessionId),
      promptMessageId
    }, now());
    if (stored?.outcome !== "stored") throw new Error("telegram_editor_prompt_not_stored");
    return started;
  } catch (error) {
    const closed = await closeTelegramEditorInput({ repository, telegramUserId, target, now, sessionId })
      .catch((closeError) => {
        console.error("[telegram] editor input cleanup failed", closeError.message);
        return { outcome: "none" };
      });
    await deactivateTelegramEditorMessages({
      session: closed?.session,
      fallbackChatId: callback.message.chat.id,
      fallbackPromptMessageId: promptMessageId,
      includeEditor: false,
      token,
      telegramClient
    });
    console.error("[telegram] editor input prompt setup failed", error.message);
    return { outcome: "start_failed" };
  }
}

async function closeTelegramEditorInput({ repository, telegramUserId, target, now, sessionId = null }) {
  if (!repository.closeTelegramInputSessionForTarget) return { outcome: "none" };
  return repository.closeTelegramInputSessionForTarget(telegramUserId, editorTargetRef(target, sessionId), now());
}

async function routeTelegramExpenseInput({ message, rawText, hasVoice, hasPhoto, commandText, user, repository, telegramUserId, language, now, token, telegramClient }) {
  if (!repository.getRoutableTelegramInputSession || (!rawText && !hasVoice && !hasPhoto)) return null;
  const session = await repository.getRoutableTelegramInputSession(telegramUserId);
  if (!session) return null;
  if (commandText === "/cancel") {
    const cancelled = await repository.cancelTelegramInputSession?.(telegramUserId, now);
    if (cancelled?.outcome === "cancelled") {
      await deactivateTelegramEditorMessages({
        session: cancelled.session ?? session,
        fallbackChatId: message.chat.id,
        includeEditor: false,
        token,
        telegramClient
      });
    }
    return sendMessage(token, message.chat.id, cancelled?.outcome === "input_in_progress"
      ? (language === "ru" ? "Изменение уже обрабатывается." : "An edit is already being processed.")
      : (language === "ru" ? "Редактирование отменено." : "Editing cancelled."), null, telegramClient);
  }
  if (commandText?.startsWith("/")) return null;
  if (hasVoice || hasPhoto) {
    return sendMessage(token, message.chat.id, language === "ru"
      ? "Сейчас я жду текст для изменения. Отправь значение текстом или нажми «Отмена»."
      : "I am waiting for text for this edit. Send a text value or tap Cancel.", null, telegramClient);
  }

  try {
    const target = await editorTargetForSession(repository, session, telegramUserId);
    if (!target) {
      await repository.closeTelegramInputSessionForTarget?.(telegramUserId, {
        targetType: session.target_type,
        targetId: session.target_id,
        itemIndex: session.item_index ?? null
      }, now);
      await deactivateTelegramEditorMessages({ session, fallbackChatId: message.chat.id, includeEditor: false, token, telegramClient });
      return sendMessage(token, message.chat.id, editorMessageForCode("expense_not_found", language), null, telegramClient);
    }
    const currentCurrency = target.item?.currency ?? target.expense?.currency_original ?? "THB";
    const value = parseEditorText(session.field, rawText, { currentCurrency, now, timeZone: user.timezone, language });
    // Fetching exchange rates may perform I/O. Do it before the input-session
    // transaction claims and locks the session/user rows.
    const prepared = session.target_type === "expense"
      ? await prepareSavedExpenseEditorChange({ repository, telegramUserId, target, field: session.field, value, now })
      : null;
    const consumed = await repository.consumeTelegramInputSession(telegramUserId, {
      sessionId: session.id,
      now,
      apply: async ({ client }) => {
        if (session.target_type === "draft") {
          await applyDraftEditorChange({ repository, telegramUserId, target, field: session.field, value, client, now });
        } else {
          await applySavedExpenseEditorChange({ repository, telegramUserId, target, field: session.field, value, client, prepared, now });
        }
      }
    });
    if (consumed.outcome === "expired") return sendMessage(token, message.chat.id, editorMessageForCode("session_expired", language), null, telegramClient);
    if (consumed.outcome !== "completed") return { ok: true };
    const refreshed = await editorTargetForSession(repository, session, telegramUserId);
    if (!refreshed) return sendMessage(token, message.chat.id, editorMessageForCode("expense_not_found", language), null, telegramClient);
    const text = formatExpenseEditor(refreshed, { language, timeZone: user.timezone });
    const keyboard = expenseEditorKeyboard(refreshed, { language });
    await deactivateTelegramEditorMessages({ session, fallbackChatId: message.chat.id, token, telegramClient });
    return sendMessage(token, message.chat.id, text, keyboard, telegramClient);
  } catch (error) {
    if (error?.code) return sendMessage(token, message.chat.id, editorMessageForCode(error.code, language), null, telegramClient);
    throw error;
  }
}

async function editorTargetForSession(repository, session, telegramUserId) {
  if (session.target_type === "draft") {
    const draft = await repository.getDraftForTelegramUser(session.target_id, telegramUserId);
    const item = draft?.items?.[Number(session.item_index)];
    return item ? { type: "draft", id: draft.id, itemIndex: Number(session.item_index), item, draft } : null;
  }
  const expense = await repository.getExpenseForTelegramUser?.(session.target_id, telegramUserId);
  return expense ? { type: "expense", id: expense.id, expense } : null;
}

async function handleExpenseEditorCallback({ callback, parsed, repository, token, miniAppUrl, telegramClient, language, user, telegramUserId, now }) {
  if (parsed.action === "cancel") {
    if (!parsed.sessionId) {
      return answerCallback(token, callback.id, editorMessageForCode("expense_not_found", language), telegramClient);
    }
    const cancelled = await closeTelegramEditorInput({
      repository,
      telegramUserId,
      target: parsed,
      now,
      sessionId: parsed.sessionId
    });
    const target = await editorTargetForSession(repository, {
      target_type: parsed.type, target_id: parsed.id, item_index: parsed.itemIndex
    }, telegramUserId);
    const message = cancelled?.outcome === "input_in_progress"
      ? (language === "ru" ? "Изменение уже обрабатывается." : "An edit is already being processed.")
      : (language === "ru" ? "Редактирование отменено." : "Editing cancelled.");
    if (cancelled?.outcome === "cancelled") {
      await deactivateTelegramEditorMessages({
        session: cancelled.session,
        fallbackChatId: callback.message.chat.id,
        fallbackMessageId: callback.message.message_id,
        includeEditor: Boolean(target),
        token,
        telegramClient
      });
    }
    await answerCallback(token, callback.id, target && cancelled?.outcome === "cancelled" ? message : editorMessageForCode("expense_not_found", language), telegramClient);
    if (!target || cancelled?.outcome !== "cancelled") return { ok: true };
    return sendMessage(
      token,
      callback.message.chat.id,
      formatExpenseEditor(target, { language, timeZone: user?.timezone }),
      expenseEditorKeyboard(target, { language }),
      telegramClient
    );
  }
  const target = parsed.action === "multi_item_selector" ? null : await editorTargetForSession(repository, {
    target_type: parsed.type, target_id: parsed.id, item_index: parsed.itemIndex
  }, telegramUserId);
  if (parsed.action === "multi_item_selector") {
    const draft = await repository.getDraftForTelegramUser(parsed.id, telegramUserId);
    if (!draft) return answerCallback(token, callback.id, editorMessageForCode("expense_not_found", language), telegramClient);
    const keyboard = { inline_keyboard: draft.items.map((item, index) => [{ text: `${index + 1}. ${item.description}`, callback_data: `ee:d:${draft.id}:${index}:o` }]) };
    return editMessageText(token, callback.message.chat.id, callback.message.message_id, language === "ru" ? "Выбери расход для редактирования." : "Choose an expense to edit.", keyboard, telegramClient);
  }
  if (!target) {
    const closed = await repository.closeTelegramInputSessionForTarget?.(telegramUserId, {
      targetType: parsed.type,
      targetId: parsed.id,
      itemIndex: parsed.type === "draft" ? parsed.itemIndex : null
    }, now());
    await deactivateTelegramEditorMessages({
      session: closed?.session,
      fallbackChatId: callback.message.chat.id,
      fallbackMessageId: callback.message.message_id,
      includeEditor: false,
      token,
      telegramClient
    });
    return answerCallback(token, callback.id, editorMessageForCode("expense_not_found", language), telegramClient);
  }
  const redraw = (nextTarget = target, keyboard = expenseEditorKeyboard(target, { language })) => editMessageText(
    token, callback.message.chat.id, callback.message.message_id,
    formatExpenseEditor(nextTarget, { language, timeZone: user?.timezone }), keyboard, telegramClient
  );
  if (parsed.action === "open") return redraw();
  if (parsed.action === "back") {
    const closed = await closeTelegramEditorInput({ repository, telegramUserId, target, now });
    if (closed?.outcome === "input_in_progress") {
      return answerCallback(token, callback.id, language === "ru" ? "Изменение уже обрабатывается." : "An edit is already being processed.", telegramClient);
    }
    await deactivateTelegramEditorMessages({
      session: closed.session,
      fallbackChatId: callback.message.chat.id,
      fallbackMessageId: callback.message.message_id,
      token,
      telegramClient
    });
    if (target.type === "expense") {
      const dashboard = await repository.dashboard(telegramUserId);
      return sendMessage(
        token, callback.message.chat.id,
        formatSavedSummary(Number(target.expense.amount_base), dashboard.snapshot, { language, expenses: [target.expense] }),
        savedExpenseKeyboard(target.expense.id, miniAppUrl, telegramUserId, language), telegramClient
      );
    }
    return sendMessage(
      token, callback.message.chat.id,
      await renderDraftPreview({ repository, user, items: target.draft.items, language }),
      draftKeyboard(target.draft.id, target.draft.items, miniAppUrl, telegramUserId, language), telegramClient
    );
  }
  if (parsed.action === "field") {
    const started = await startTelegramEditorTextInput({
      repository, telegramUserId, target, field: parsed.field, callback, language, now, token, telegramClient
    });
    if (started?.outcome !== "started") return answerCallback(token, callback.id, started?.outcome === "input_in_progress"
      ? (language === "ru" ? "Изменение уже обрабатывается." : "An edit is already being processed.")
      : (language === "ru" ? "Не удалось начать редактирование. Попробуй ещё раз." : "Could not start editing. Please try again."), telegramClient);
    await answerCallback(token, callback.id, language === "ru" ? "Жду текстовое значение." : "Waiting for a text value.", telegramClient);
    return { ok: true };
  }
  if (parsed.action === "category_menu") return redraw(target, expenseCategoryKeyboard(target, undefined, { language }));
  if (parsed.action === "category_page") return redraw(target, expenseCategoryKeyboard(target, undefined, { language, page: parsed.page }));
  if (parsed.action === "date_menu") return redraw(target, expenseDateKeyboard(target, language));
  if (parsed.action === "budget_menu") return redraw(target, expenseTreatmentKeyboard(target, language));
  if (parsed.action === "category" || parsed.action === "budget_impact" || (parsed.action === "date" && parsed.value !== "custom")) {
    if (parsed.action === "budget_impact" && (target.item ?? target.expense)?.budget_impact === parsed.value) {
      return answerCallback(token, callback.id, language === "ru" ? "Уже выбрано." : "Already selected.", telegramClient);
    }
    const field = parsed.action === "category" ? "category" : (parsed.action === "budget_impact" ? "budget_impact" : "spent_at");
    const value = parsed.action === "date"
      ? editorCalendarDate(now(), user?.timezone, parsed.value === "yesterday" ? -1 : 0)
      : parsed.value;
    try {
      if (parsed.type === "draft") await applyDraftEditorChange({ repository, telegramUserId, target, field, value, now: now() });
      else await applySavedExpenseEditorChange({ repository, telegramUserId, target, field, value, now: now() });
      const refreshed = await editorTargetForSession(repository, { target_type: parsed.type, target_id: parsed.id, item_index: parsed.itemIndex }, telegramUserId);
      await answerCallback(token, callback.id, language === "ru" ? "Изменено." : "Updated.", telegramClient);
      return redraw(refreshed);
    } catch (error) {
      return answerCallback(token, callback.id, editorMessageForCode(error.code ?? "expense_not_found", language), telegramClient);
    }
  }
  if (parsed.action === "date" && parsed.value === "custom") {
    const started = await startTelegramEditorTextInput({
      repository, telegramUserId, target, field: "spent_at", callback, language, now, token, telegramClient
    });
    if (started?.outcome !== "started") return answerCallback(token, callback.id, started?.outcome === "input_in_progress"
      ? (language === "ru" ? "Изменение уже обрабатывается." : "An edit is already being processed.")
      : (language === "ru" ? "Не удалось начать редактирование. Попробуй ещё раз." : "Could not start editing. Please try again."), telegramClient);
    await answerCallback(token, callback.id, language === "ru" ? "Жду текстовое значение." : "Waiting for a text value.", telegramClient);
    return { ok: true };
  }
  if (parsed.action === "delete") return redraw(target, expenseDeleteKeyboard(target, language));
  if (parsed.action === "delete_confirm" && parsed.type === "expense") {
    try {
      await repository.deleteExpenseForTelegramUser(parsed.id, telegramUserId, now());
      const closed = await closeTelegramEditorInput({ repository, telegramUserId, target, now });
      await deactivateTelegramEditorMessages({
        session: closed?.session,
        fallbackChatId: callback.message.chat.id,
        includeEditor: false,
        token,
        telegramClient
      });
      await answerCallback(token, callback.id, language === "ru" ? "Расход удалён." : "Expense deleted.", telegramClient);
      return editMessageText(token, callback.message.chat.id, callback.message.message_id, language === "ru" ? "Расход удалён." : "Expense deleted.", null, telegramClient);
    } catch (error) {
      return answerCallback(token, callback.id, editorMessageForCode(error.code ?? "expense_not_found", language), telegramClient);
    }
  }
  return answerCallback(token, callback.id, language === "ru" ? "Недоступно." : "Unavailable.", telegramClient);
}

export async function handleCallback({ update, repository, token, miniAppUrl, telegramClient, adminAlertService, expenseExportService, trace, now = () => new Date() }) {
  const callback = update.callback_query;
  const [action, draftId, itemIndex, value] = callback.data.split(":");
  const telegramUserId = callback.from.id;
  trace.start("user_context");
  const user = await repository.getUserByTelegramId?.(telegramUserId);
  trace.end("user_context");
  const language = user?.interface_language ?? "en";

  const expenseEditorCallback = parseExpenseEditorCallback(callback.data);
  if (expenseEditorCallback) {
    return handleExpenseEditorCallback({ callback, parsed: expenseEditorCallback, repository, token, miniAppUrl, telegramClient, language, user, telegramUserId, now });
  }

  if (action === "delete_me") {
    if (draftId === "cancel") {
      await repository.cancelAccountDeletion(callback.from.id, { source: ACCOUNT_DELETION_SOURCE_TELEGRAM });
      return sendTelegramResponse(trace, async () => {
        await answerCallback(token, callback.id, botText(language, "cancelledCallback"), telegramClient);
        return editMessageText(token, callback.message.chat.id, callback.message.message_id, accountDeletionText(language, "cancelled"), null, telegramClient);
      });
    }
    if (draftId === "advance") {
      const request = await repository.advanceAccountDeletion(callback.from.id, { source: ACCOUNT_DELETION_SOURCE_TELEGRAM });
      if (!request) {
        return sendTelegramResponse(trace, async () => {
          await answerCallback(token, callback.id, accountDeletionText(language, "expiredCallback"), telegramClient);
          return editMessageText(
            token,
            callback.message.chat.id,
            callback.message.message_id,
            accountDeletionText(language, "expired"),
            null,
            telegramClient
          );
        });
      }
      return sendTelegramResponse(trace, async () => {
        await answerCallback(token, callback.id, botText(language, "savedCallback"), telegramClient);
        return editMessageText(
          token,
          callback.message.chat.id,
          callback.message.message_id,
          accountDeletionText(language, "promptDelete"),
          accountDeletionButtons(language, request.stage),
          telegramClient
        );
      });
    }
  }

  const budgetTopupCallback = parseBudgetTopupCallback(callback.data);
  if (budgetTopupCallback) {
    return handleBudgetTopupCallback({ callback, parsed: budgetTopupCallback, repository, token, miniAppUrl, telegramClient, language, user, trace, now });
  }

  const draftCallback = parseDraftCallback(callback.data);
  if (draftCallback) {
    return handleDraftCallback({ callback, parsed: draftCallback, repository, token, miniAppUrl, telegramClient, adminAlertService, language, user, trace, now });
  }

  if (action === "ppr") {
    return handlePlannedPaymentReminderCallback({
      callback,
      action: draftId,
      plannedExpenseId: Number(itemIndex),
      occurrenceDate: decodePlannedReminderDate(value),
      user,
      telegramUserId,
      language,
      repository,
      token,
      miniAppUrl,
      telegramClient,
      trace,
      now
    });
  }

  if (action === "export") {
    const period = draftId === "all" ? "all" : "month";
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, botText(language, "exportPreparingCallback"), telegramClient);
      const result = await expenseExportService.requestExport({
        telegramUserId,
        chatId: callback.message.chat.id,
        period,
        language
      });
      if (result.status === "sent") return { ok: true };
      return sendMessage(token, callback.message.chat.id, result.message, null, telegramClient);
    });
  }

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
    const items = updateDraftItem(draft, Number(itemIndex), { category_slug: value, category_source: "user", needs_review: false, confidence: 0.9 });
    const updated = await repository.updateDraftItems(draftId, telegramUserId, items);
    trace.end("db_save");
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, botText(language, "categoryUpdatedCallback"), telegramClient);
      return sendMessage(token, callback.message.chat.id, await renderDraftPreview({ repository, user, items: updated.items, language }), draftKeyboard(updated.id, updated.items, miniAppUrl, telegramUserId, language), telegramClient);
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
      return sendMessage(token, callback.message.chat.id, await renderDraftPreview({ repository, user, items: updated.items, language }), draftKeyboard(updated.id, updated.items, miniAppUrl, telegramUserId, language), telegramClient);
    });
  }

  if (action === "impact") {
    trace.start("db_save");
    const impact = normalizeBudgetImpact(value);
    const draft = await repository.getDraftForTelegramUser(draftId, telegramUserId);
    const items = updateDraftItem(draft, Number(itemIndex), { budget_impact: impact });
    const updated = await repository.updateDraftItems(draftId, telegramUserId, items);
    trace.end("db_save");
    const text = await renderDraftPreview({ repository, user, items: updated.items, language });
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
    return handleConfirmDraft(trace, token, telegramClient, callback, draftId, telegramUserId, language, miniAppUrl, repository, user, adminAlertService, now);
  }

  if (action === "cancel") {
    return handleCancelDraft(trace, token, telegramClient, callback, draftId, telegramUserId, language, repository, user, now);
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

async function handleBudgetTopupCallback({ callback, parsed, repository, token, miniAppUrl, telegramClient, language, user, trace, now }) {
  const telegramUserId = callback.from.id;
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  if (parsed.action === "cancel") {
    trace.start("db_save");
    const outcome = await repository.cancelBudgetTopupDraft(parsed.id, telegramUserId, now());
    trace.end("db_save");
    if (outcome.cancelled) {
      await safeRecordAppEvent(repository, user?.id, "budget_topup_draft_cancelled", {});
    }
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, botText(language, "cancelledCallback"), telegramClient);
      const text = botText(language, "budgetTopupCancelled");
      const replyMarkup = budgetTopupMiniAppKeyboard(miniAppUrl, telegramUserId, language);
      if (messageId) {
        try {
          return await editMessageText(token, chatId, messageId, text, replyMarkup, telegramClient);
        } catch {}
      }
      return sendMessage(token, chatId, text, replyMarkup, telegramClient);
    });
  }
  if (parsed.action === "undo") {
    trace.start("db_save");
    const result = await repository.undoBudgetTopup(parsed.id, telegramUserId, now());
    trace.end("db_save");
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, result.undone ? botText(language, "savedCallback") : botText(language, "technicalError"), telegramClient);
      const text = result.undone
        ? formatBudgetTopupUndoSuccess(result.topup, result.dashboardSnapshot, language)
        : botText(language, "budgetTopupUndoExpired");
      const replyMarkup = result.undone
        ? budgetTopupMiniAppKeyboard(miniAppUrl, telegramUserId, language)
        : { inline_keyboard: [] };
      if (messageId) {
        try {
          return await editMessageText(token, chatId, messageId, text, replyMarkup, telegramClient);
        } catch {}
      }
      return sendMessage(token, chatId, text, replyMarkup, telegramClient);
    });
  }

  trace.start("db_save");
  const result = await repository.confirmBudgetTopupDraft(parsed.id, telegramUserId, now());
  trace.end("db_save");
  if (result.outcome === "expired") {
    return sendTelegramResponse(trace, () => answerCallback(token, callback.id, botText(language, "budgetTopupExpired"), telegramClient));
  }
  if (result.outcome === "replaced_by_newer") {
    return sendTelegramResponse(trace, () => answerCallback(token, callback.id, botText(language, "budgetTopupReplacedByNewer"), telegramClient));
  }
  if (result.outcome === "wrong_month") {
    return sendTelegramResponse(trace, () => answerCallback(token, callback.id, botText(language, "budgetTopupWrongMonth"), telegramClient));
  }
  if (!result.alreadySaved) {
    await safeRecordAppEvent(repository, user?.id, "budget_topup_draft_confirmed", {
      kind: result.topup?.kind,
      currency: result.topup?.currency_original,
      amountBase: Number(result.topup?.amount_base ?? 0)
    });
  }
  return sendTelegramResponse(trace, async () => {
    await answerCallback(token, callback.id, result.alreadySaved ? botText(language, "alreadySavedCallback") : botText(language, "savedCallback"), telegramClient);
    const text = formatBudgetTopupSuccess(result.topup, result.dashboardSnapshot, language);
    const replyMarkup = budgetTopupSuccessKeyboard(result.topup.id, miniAppUrl, telegramUserId, language);
    if (messageId) {
      try {
        return await editMessageText(token, chatId, messageId, text, replyMarkup, telegramClient);
      } catch {}
    }
    return sendMessage(token, chatId, text, replyMarkup, telegramClient);
  });
}

async function handleDraftCallback({ callback, parsed, repository, token, miniAppUrl, telegramClient, adminAlertService, language, user, trace, now }) {
  const telegramUserId = callback.from.id;
  if (parsed.action === "confirm") {
    return handleConfirmDraft(trace, token, telegramClient, callback, parsed.draftId, telegramUserId, language, miniAppUrl, repository, user, adminAlertService, now);
  }
  if (parsed.action === "cancel") {
    return handleCancelDraft(trace, token, telegramClient, callback, parsed.draftId, telegramUserId, language, repository, user, now);
  }
  if (parsed.action === "review") {
    trace.start("db_save");
    await repository.moveDraftToInbox(parsed.draftId, telegramUserId);
    trace.end("db_save");
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, botText(language, "movedCallback"), telegramClient);
      return sendMessage(token, callback.message.chat.id, botText(language, "movedToInbox"), inboxDraftKeyboard(miniAppUrl, telegramUserId, parsed.draftId, language), telegramClient);
    });
  }
  if (parsed.action === "type" || parsed.action === "category") {
    const draft = await repository.getDraftForTelegramUser(parsed.draftId, telegramUserId);
    let items;
    let toast;
    if (parsed.action === "type") {
      const impact = parsed.value === "l" ? "large_oneoff" : "regular";
      if (draft?.items?.[0]?.budget_impact === impact) {
        return sendTelegramResponse(trace, () => answerCallback(
          token, callback.id, language === "ru" ? "Уже выбрано." : "Already selected.", telegramClient
        ));
      }
      items = updateDraftItem(draft, 0, { budget_impact: impact });
      toast = language === "ru" ? "Тип обновлен" : "Type updated";
    } else {
      const slug = categorySlugFromCode(parsed.value);
      if (!slug) return sendTelegramResponse(trace, () => answerCallback(token, callback.id, botText(language, "technicalError"), telegramClient));
      items = updateDraftItem(draft, 0, { category_slug: slug, category_source: "user", needs_review: false, confidence: 0.9 });
      toast = botText(language, "categoryUpdatedCallback");
    }
    const updated = await repository.updateDraftItems(parsed.draftId, telegramUserId, items);
    return redrawDraft(trace, token, telegramClient, callback, updated, language, miniAppUrl, telegramUserId, repository, user, toast);
  }
}

async function redrawDraft(trace, token, telegramClient, callback, updated, language, miniAppUrl, telegramUserId, repository, user, toast) {
  const text = await renderDraftPreview({ repository, user, items: updated.items, language });
  const replyMarkup = draftKeyboard(updated.id, updated.items, miniAppUrl, telegramUserId, language);
  return sendTelegramResponse(trace, async () => {
    await answerCallback(token, callback.id, toast, telegramClient).catch(() => {});
    if (callback.message?.message_id) {
      return editMessageText(token, callback.message.chat.id, callback.message.message_id, text, replyMarkup, telegramClient);
    }
    return sendMessage(token, callback.message.chat.id, text, replyMarkup, telegramClient);
  });
}

async function handleConfirmDraft(trace, token, telegramClient, callback, draftId, telegramUserId, language, miniAppUrl, repository, user, adminAlertService, now) {
  const startedAt = performance.now();
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  let callbackAckSucceeded = false;
  try {
    await answerCallback(token, callback.id, botText(language, "draftSavingCallback"), telegramClient);
    callbackAckSucceeded = true;
  } catch (error) {
    console.error("[telegram] confirming draft callback acknowledgement failed", error.message);
  }
  const callbackAckMs = elapsedSince(startedAt);

  trace.start("db_save");
  let result;
  let outcome;
  let persistenceError = null;
  const dbSaveStartedAt = performance.now();
  let dbSaveMs = null;
  try {
    result = await repository.saveDraftAsExpense(draftId, telegramUserId);
    dbSaveMs = elapsedSince(dbSaveStartedAt);
    outcome = result.alreadySaved ? "already_saved" : "success";
    trace.end("db_save");
  } catch (error) {
    dbSaveMs = elapsedSince(dbSaveStartedAt);
    trace.end("db_save", {}, false, error);
    if (error instanceof DraftCanceledError) outcome = "cancelled";
    else if (error instanceof CategoryRequiredError) outcome = "category_required";
    else {
      outcome = "failed";
      persistenceError = error;
      console.error("[telegram] saving draft failed", error.message);
    }
  }

  const expenses = Array.isArray(result?.expenses) ? result.expenses : [];
  const successfulSave = outcome === "success" || outcome === "already_saved";
  let summaryBuildMs = null;
  let text;
  let replyMarkup;
  if (successfulSave) {
    const summaryStartedAt = performance.now();
    const total = expenses.reduce((sum, expense) => sum + Number(expense.amount_base), 0);
    text = formatSavedSummary(total, result.dashboardSnapshot, { language, expenses });
    replyMarkup = expenses.length === 1
      ? savedExpenseKeyboard(expenses[0].id, miniAppUrl, telegramUserId, language)
      : appKeyboard(miniAppUrl, telegramUserId, language);
    summaryBuildMs = elapsedSince(summaryStartedAt);
  } else if (outcome === "cancelled") {
    text = botText(language, "draftCanceledMessage");
    replyMarkup = { inline_keyboard: [] };
  } else {
    text = botText(language, outcome === "category_required" ? "chooseCategoryAlert" : "draftSaveFailed");
  }

  const terminal = await sendConfirmDraftTerminalResponse({
    trace, outcome, token, telegramClient, chatId, messageId, text, replyMarkup
  });
  const userResultMs = elapsedSince(startedAt);

  let cleanupMs = null;
  const backgroundTasks = [];
  if (outcome === "failed" && persistenceError) {
    backgroundTasks.push(safeNotifyAdminError(adminAlertService, persistenceError, {
      source: "telegram", route: "telegram_confirm", stage: "db_save", userId: user?.id
    }));
  }
  if (terminal.telegramUpdateMode === "failed" && terminal.error) {
    backgroundTasks.push(safeNotifyAdminError(adminAlertService, terminal.error, {
      source: "telegram", route: "telegram_confirm", stage: "telegram_update", userId: user?.id
    }));
  }
  if (outcome === "success" && !result.alreadySaved) {
    backgroundTasks.push(
      safeRecordAppEvent(repository, user?.id, "expense_draft_confirmed", { draftType: "regular" }),
      ...expenses.map(() => safeRecordAppEvent(repository, user?.id, "expense_saved", { draftType: "regular" }))
    );
  }
  if (successfulSave || outcome === "cancelled") {
    const cleanupStartedAt = performance.now();
    backgroundTasks.push(safeConfirmDraftCleanup({
      repository, telegramUserId, draftId, now, chatId, messageId,
      clearOriginalDraftKeyboard: terminal.clearOriginalDraftKeyboard,
      token, telegramClient
    }).finally(() => {
      cleanupMs = elapsedSince(cleanupStartedAt);
    }));
  }
  await Promise.allSettled(backgroundTasks);

  const totalMs = elapsedSince(startedAt);
  await safeRecordAppEvent(repository, null, "draft_confirm_processing_completed", {
    outcome,
    callbackAckMs,
    callbackAckSucceeded,
    dbSaveMs,
    summaryBuildMs,
    telegramUpdateMs: terminal.telegramUpdateMs,
    telegramUpdateSucceeded: terminal.telegramUpdateSucceeded,
    telegramUpdateMode: terminal.telegramUpdateMode,
    userResultMs,
    cleanupMs,
    totalMs,
    expenseCount: successfulSave ? expenses.length : 0,
    source: "telegram"
  });
  return { ok: true };
}

async function sendConfirmDraftTerminalResponse({ trace, outcome, token, telegramClient, chatId, messageId, text, replyMarkup }) {
  const startedAt = performance.now();
  let telegramUpdateMode = outcome === "category_required" || outcome === "failed" ? "send" : "edit";
  let telegramUpdateSucceeded = false;
  let terminalError = null;
  try {
    await sendTelegramResponse(trace, async () => {
      if (outcome === "category_required" || outcome === "failed") {
        await sendMessage(token, chatId, text, null, telegramClient);
        return;
      }
      if (messageId) {
        try {
          await editMessageText(token, chatId, messageId, text, replyMarkup, telegramClient);
          return;
        } catch (error) {
          console.error("[telegram] editing terminal draft confirmation failed, falling back to new message", error.message);
        }
      }
      telegramUpdateMode = "fallback_send";
      await sendMessage(token, chatId, text, replyMarkup, telegramClient);
    });
    telegramUpdateSucceeded = true;
  } catch (error) {
    telegramUpdateMode = "failed";
    terminalError = error;
    console.error("[telegram] terminal draft confirmation delivery failed", error.message);
  }
  return {
    telegramUpdateMs: elapsedSince(startedAt),
    telegramUpdateSucceeded,
    telegramUpdateMode,
    error: terminalError,
    clearOriginalDraftKeyboard: telegramUpdateSucceeded && telegramUpdateMode === "fallback_send" && Boolean(messageId)
  };
}

async function safeConfirmDraftCleanup({ repository, telegramUserId, draftId, now, chatId, messageId, clearOriginalDraftKeyboard, token, telegramClient }) {
  try {
    const closed = await closeTelegramEditorInput({
      repository,
      telegramUserId,
      target: { type: "draft", id: Number(draftId), itemIndex: undefined },
      now
    });
    await deactivateTelegramEditorMessages({
      session: closed?.session,
      fallbackChatId: chatId,
      includeEditor: false,
      token,
      telegramClient
    });
    if (clearOriginalDraftKeyboard) {
      await editMessageReplyMarkup(token, chatId, messageId, { inline_keyboard: [] }, telegramClient)
        .catch((error) => console.error("[telegram] old draft keyboard cleanup failed", error.message));
    }
  } catch (error) {
    console.error("[telegram] confirmed draft editor cleanup failed", error.message);
  }
}

async function handleCancelDraft(trace, token, telegramClient, callback, draftId, telegramUserId, language, repository, user, now) {
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  const sourceMessageId = callback.message?.reply_to_message?.message_id;
  trace.start("db_save");
  const outcome = await repository.cancelDraft(draftId, telegramUserId);
  trace.end("db_save");
  if (!outcome.canceled) {
    const reasonKey = outcome.reason === "already_confirmed" ? "alreadySavedCallback"
      : outcome.reason === "already_cancelled" ? "draftCanceledAlert"
      : "technicalError";
    return sendTelegramResponse(trace, () => answerCallback(token, callback.id, botText(language, reasonKey), telegramClient));
  }
  await safeRecordAppEvent(repository, user?.id, "expense_draft_cancelled", { draftType: "regular" });
  const closed = await closeTelegramEditorInput({
    repository,
    telegramUserId,
    target: { type: "draft", id: Number(draftId), itemIndex: undefined },
    now
  });
  await deactivateTelegramEditorMessages({
    session: closed?.session,
    fallbackChatId: chatId,
    includeEditor: false,
    token,
    telegramClient
  });
  return sendTelegramResponse(trace, async () => {
    await answerCallback(token, callback.id, botText(language, "cancelledCallback"), telegramClient);
    const text = botText(language, "draftCanceledMessage");
    if (messageId) {
      try {
        return await editMessageText(token, chatId, messageId, text, { inline_keyboard: [] }, telegramClient);
      } catch (error) {
        console.error("[telegram] editing cancelled draft failed, falling back to new message", error.message);
        await editMessageReplyMarkup(token, chatId, messageId, { inline_keyboard: [] }, telegramClient)
          .catch((markupError) => console.error("[telegram] could not clear old draft keyboard", markupError.message));
      }
    }
    const replyParameters = sourceMessageId == null ? null : {
      message_id: sourceMessageId,
      allow_sending_without_reply: true
    };
    try {
      return await sendMessage(
        token,
        chatId,
        text,
        { inline_keyboard: [] },
        telegramClient,
        null,
        { replyParameters, retryPlainText: false }
      );
    } catch (error) {
      if (!replyParameters) throw error;
      console.error("[telegram] replying with cancelled draft failed, falling back without reply", error.message);
      return sendMessage(token, chatId, text, { inline_keyboard: [] }, telegramClient);
    }
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

async function handlePlannedPaymentReminderCallback({
  callback,
  action,
  plannedExpenseId,
  occurrenceDate,
  user,
  telegramUserId,
  language,
  repository,
  token,
  miniAppUrl,
  telegramClient,
  trace,
  now
}) {
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const context = occurrenceDate
    ? await repository.getPlannedPaymentReminderForTelegramUser?.(
      plannedExpenseId,
      telegramUserId,
      occurrenceDate
    )
    : null;
  if (!context) {
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, plannedReminderText(language, "unavailable"), telegramClient);
      return editMessageText(
        token,
        chatId,
        messageId,
        plannedReminderText(language, "unavailable"),
        { inline_keyboard: [] },
        telegramClient
      );
    });
  }

  if (action === "p") {
    await answerCallback(token, callback.id, plannedReminderText(language, "saving"), telegramClient)
      .catch((error) => console.error("[planned-reminder] callback acknowledgement failed", error.message));
    let expense;
    try {
      expense = await repository.payPlannedExpenseForTelegramUser(
        plannedExpenseId,
        telegramUserId,
        now(),
        { occurrenceDate }
      );
    } catch (error) {
      const terminalKey = error.code === "already_paid"
        ? "alreadyPaid"
        : ["invalid_occurrence", "future_occurrence"].includes(error.code)
          ? "invalidOccurrence"
          : "unavailable";
      if (error.code !== "already_paid" && !["invalid_occurrence", "future_occurrence", "not_found"].includes(error.code)) {
        throw error;
      }
      if (error.code === "already_paid") {
        await repository.markPlannedPaymentReminderTerminal?.(plannedExpenseId, occurrenceDate, "paid");
      }
      return safeReplacePlannedReminder({
        token,
        chatId,
        messageId,
        text: plannedReminderText(language, terminalKey),
        replyMarkup: { inline_keyboard: [] },
        telegramClient
      });
    }

    let dashboardSnapshot = null;
    try {
      dashboardSnapshot = (await repository.dashboard(telegramUserId, now()))?.snapshot ?? null;
    } catch (error) {
      console.warn("[planned-reminder] dashboard summary unavailable after commit", {
        plannedExpenseId,
        occurrenceDate,
        message: error?.message
      });
    }
    const text = formatSavedSummary(Number(expense.amount_base), dashboardSnapshot, {
      language,
      expenses: [expense]
    });
    await repository.markPlannedPaymentReminderTerminal?.(plannedExpenseId, occurrenceDate, "paid");
    await safeRecordAppEvent(repository, user?.id, "planned_payment_reminder_paid_clicked", {
      local_date: occurrenceDate,
      recurrence: context.recurrence,
      source: "telegram",
      outcome: "paid"
    });
    return safeReplacePlannedReminder({
      token,
      chatId,
      messageId,
      text,
      replyMarkup: plannedPaymentSuccessKeyboard(miniAppUrl, telegramUserId, language),
      telegramClient
    });
  }

  if (action === "s") {
    const timezoneUsed = normalizeTimeZone(user?.timezone ?? context.timezone).timeZone;
    const nextReminderLocalDate = nextDateKey(timezoneLocalDateKey(now(), timezoneUsed));
    const snoozed = await repository.snoozePlannedPaymentReminderForTelegramUser?.(
      plannedExpenseId,
      telegramUserId,
      occurrenceDate,
      nextReminderLocalDate,
      timezoneUsed
    );
    await safeRecordAppEvent(repository, user?.id, "planned_payment_reminder_snoozed", {
      local_date: occurrenceDate,
      recurrence: context.recurrence,
      source: "telegram",
      outcome: snoozed ? "snoozed" : "stale"
    });
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, plannedReminderText(language, "snoozedToast"), telegramClient);
      return editMessageText(
        token,
        chatId,
        messageId,
        plannedReminderText(language, snoozed ? "snoozed" : "unavailable"),
        { inline_keyboard: [] },
        telegramClient
      );
    });
  }

  if (action === "d") {
    await safeRecordAppEvent(repository, user?.id, "planned_payment_reminder_disable_started", {
      local_date: occurrenceDate,
      recurrence: context.recurrence,
      source: "telegram"
    });
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, plannedReminderText(language, "confirmDisableToast"), telegramClient);
      return editMessageText(
        token,
        chatId,
        messageId,
        plannedDisableConfirmationText(language, context.description),
        plannedPaymentDisableConfirmationKeyboard(plannedExpenseId, occurrenceDate, language),
        telegramClient
      );
    });
  }

  if (action === "c") {
    const timezoneUsed = normalizeTimeZone(user?.timezone ?? context.timezone).timeZone;
    const sentLocalDate = String(
      context.last_sent_local_date ?? timezoneLocalDateKey(now(), timezoneUsed)
    ).slice(0, 10);
    const deliveryReason = occurrenceDate === sentLocalDate ? "due_today" : "snoozed";
    return sendTelegramResponse(trace, async () => {
      await answerCallback(token, callback.id, plannedReminderText(language, "cancelled"), telegramClient);
      return editMessageText(
        token,
        chatId,
        messageId,
        formatPlannedPaymentReminder(context, language, {
          occurrenceDate,
          localDate: sentLocalDate,
          deliveryReason
        }),
        plannedPaymentReminderKeyboard(plannedExpenseId, occurrenceDate, miniAppUrl, telegramUserId, language),
        telegramClient
      );
    });
  }

  if (action === "y") {
    await answerCallback(token, callback.id, plannedReminderText(language, "disabling"), telegramClient);
    const disabled = await repository.deactivatePlannedExpense(telegramUserId, plannedExpenseId, now());
    if (!disabled) {
      return safeReplacePlannedReminder({
        token,
        chatId,
        messageId,
        text: plannedReminderText(language, "unavailable"),
        replyMarkup: { inline_keyboard: [] },
        telegramClient
      });
    }
    const outstanding = await repository.listOutstandingPlannedPaymentReminders(plannedExpenseId);
    if (!outstanding.some((reminder) =>
      Number(reminder.tg_chat_id) === Number(chatId)
      && Number(reminder.tg_message_id) === Number(messageId))) {
      outstanding.push({
        ...context,
        tg_chat_id: chatId,
        tg_message_id: messageId,
        interface_language: language
      });
    }
    await updatePlannedPaymentReminderMessages({
      token,
      reminders: outstanding,
      outcome: "disabled",
      source: "telegram",
      telegramClient
    });
    await repository.markAllPlannedPaymentRemindersTerminal(plannedExpenseId, "disabled");
    await safeRecordAppEvent(repository, user?.id, "planned_payment_reminder_disabled", {
      local_date: occurrenceDate,
      recurrence: context.recurrence,
      source: "telegram",
      outcome: "disabled"
    });
    return { ok: true };
  }

  return answerCallback(token, callback.id, plannedReminderText(language, "unavailable"), telegramClient);
}

function decodePlannedReminderDate(value) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(value ?? ""));
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function nextDateKey(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
}

function plannedDisableConfirmationText(language, description) {
  const safeDescription = escapeTelegramHtml(description);
  return language === "ru"
    ? `Отключить плановую оплату «${safeDescription}»?\n\nБудущие неоплаченные вхождения исчезнут из плана. Уже оплаченные расходы сохранятся. Сегодняшний уже зафиксированный дневной лимит не изменится.`
    : `Disable planned payment “${safeDescription}”?\n\nFuture unpaid occurrences will leave the plan. Paid expenses will remain. Today’s fixed daily limit will not change.`;
}

function plannedReminderText(language, key) {
  const messages = language === "ru"
    ? {
      saving: "Сохраняю…",
      alreadyPaid: "Эта оплата уже отмечена.",
      invalidOccurrence: "Эту плановую оплату сейчас нельзя отметить.",
      unavailable: "Эта плановая оплата больше недоступна.",
      snoozedToast: "Напомню завтра",
      snoozed: "⏰ Напомню завтра вечером.",
      confirmDisableToast: "Нужно подтверждение",
      cancelled: "Отменено",
      disabling: "Отключаю…",
      disabled: "🔕 Плановая оплата отключена."
    }
    : {
      saving: "Saving…",
      alreadyPaid: "This payment is already marked as paid.",
      invalidOccurrence: "This planned payment cannot be marked now.",
      unavailable: "This planned payment is no longer available.",
      snoozedToast: "I’ll remind you tomorrow",
      snoozed: "⏰ I’ll remind you tomorrow evening.",
      confirmDisableToast: "Confirmation required",
      cancelled: "Cancelled",
      disabling: "Disabling…",
      disabled: "🔕 Planned payment disabled."
    };
  return messages[key] ?? messages.unavailable;
}

async function safeReplacePlannedReminder({ token, chatId, messageId, text, replyMarkup, telegramClient }) {
  try {
    return await editMessageText(token, chatId, messageId, text, replyMarkup, telegramClient);
  } catch (error) {
    console.error("[planned-reminder] message edit failed after commit", error.message);
    return sendMessage(token, chatId, text, replyMarkup, telegramClient);
  }
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

async function sendMessage(token, chatId, text, replyMarkup, telegramClient, plainTextFallback = null, options = {}) {
  const { replyParameters = null, retryPlainText = true } = options;
  const clientMessage = {
    chatId,
    text,
    replyMarkup,
    ...(replyParameters ? { replyParameters } : {})
  };
  if (telegramClient) {
    try {
      return await telegramClient.sendMessage(clientMessage);
    } catch (error) {
      if (!retryPlainText || !shouldRetryPlainText(error)) throw error;
      return telegramClient.sendMessage({
        ...clientMessage,
        text: plainTextFallback ?? stripTelegramHtml(text)
      });
    }
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
    reply_parameters: replyParameters,
    reply_markup: replyMarkup
  };
  try {
    return await telegramRequest(token, "sendMessage", body);
  } catch (error) {
    if (!retryPlainText || !shouldRetryPlainText(error)) throw error;
    console.error("[telegram] sendMessage HTML rejected, retrying plain text", error.message);
    return telegramRequest(token, "sendMessage", {
      ...body,
      text: plainTextFallback ?? stripTelegramHtml(text),
      parse_mode: undefined
    });
  }
}

export async function sendTelegramMessage({ token, chatId, text, replyMarkup = null, replyParameters = null, telegramClient = null }) {
  return sendMessage(token, chatId, text, replyMarkup, telegramClient, null, { replyParameters });
}

async function sendAdminStatsMessage({ token, chatId, sections, command, reportType, telegramClient }) {
  const html = renderAdminRichMessage(sections, { reportType });
  if (richMessageTextLength(html) > RICH_MESSAGE_MAX_LENGTH) {
    logAdminRichFallback({ command, reportType, errorClass: "size", reason: "rich_message_too_long" });
    return sendAdminStatsHtmlFallback({ token, chatId, sections, telegramClient });
  }
  try {
    return await sendTelegramRichMessage({ token, chatId, html, telegramClient });
  } catch (error) {
    if (error?.status === 400) {
      logAdminRichFallback({ command, reportType, status: 400, reason: "rich_message_rejected" });
      return sendAdminStatsHtmlFallback({ token, chatId, sections, telegramClient });
    }
    throw new AmbiguousAdminRichMessageError(error);
  }
}

function richMessageTextLength(html) {
  const text = String(html)
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39);/g, "x");
  return Array.from(text).length;
}

async function sendAdminStatsHtmlFallback({ token, chatId, sections, telegramClient }) {
  const parts = formatAdminMessageParts(sections);
  let response;
  for (const part of parts) {
    response = await sendMessage(token, chatId, part.html, null, telegramClient, part.plainText);
  }
  return response;
}

function logAdminRichFallback({ command, reportType, status = null, errorClass, reason }) {
  console.warn("[telegram] admin rich message fallback", { command, reportType, status, errorClass, reason });
}

class AmbiguousAdminRichMessageError extends Error {
  constructor(cause) {
    super("admin rich message delivery is ambiguous", { cause });
  }
}

export async function sendTelegramRichMessage({ token, chatId, html, replyMarkup = null, telegramClient = null }) {
  if (telegramClient) return telegramClient.sendRichMessage({ chatId, html, replyMarkup });
  if (!token) {
    const logMessageId = nextLogMessageId();
    console.log("[telegram:sendRichMessage]", { chatId, html, replyMarkup });
    return { ok: true, result: { message_id: logMessageId } };
  }
  return telegramRequest(token, "sendRichMessage", {
    chat_id: chatId,
    rich_message: { html, skip_entity_detection: true },
    reply_markup: replyMarkup
  });
}

export async function sendTelegramDocument({ token, telegramClient = null, chatId, filename, content, contentType, caption = null }) {
  if (telegramClient?.sendDocument) {
    return telegramClient.sendDocument({ chatId, filename, content, contentType, caption });
  }
  if (!token) {
    console.log("[telegram:sendDocument]", {
      chatId,
      filename,
      contentType,
      caption,
      bytes: Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content ?? ""))
    });
    return { ok: true };
  }
  const form = new FormData();
  form.set("chat_id", String(chatId));
  if (caption) form.set("caption", caption);
  const fileContent = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ""), "utf8");
  form.set("document", new Blob([fileContent], { type: contentType ?? "text/csv; charset=utf-8" }), filename);
  return telegramRequest(token, "sendDocument", form);
}

export async function updateDraftMessageToSaved({ token, draft, text, replyMarkup, telegramClient }) {
  const chatId = draft?.tg_chat_id;
  const messageId = draft?.tg_message_id;
  if (!chatId || !messageId) {
    console.log("[telegram] no stored message reference for draft", draft?.id);
    return;
  }
  try {
    await editMessageText(token, chatId, messageId, text, replyMarkup, telegramClient);
  } catch (error) {
    if (isMessageNotModified(error)) return;
    console.error("[telegram] update draft message to saved failed; sending fallback", error.message);
    try { await sendMessage(token, chatId, text, replyMarkup, telegramClient); }
    catch (sendError) { console.error("[telegram] fallback saved message failed", sendError.message); }
    try { await editMessageReplyMarkup(token, chatId, messageId, { inline_keyboard: [] }, telegramClient); }
    catch (markupError) { console.error("[telegram] could not clear old draft keyboard", markupError.message); }
  }
}

export async function updateTelegramMessageAfterExpenseDelete({ token, draft, remainingExpenses, dashboardSnapshot, language, miniAppUrl, telegramUserId, telegramClient }) {
  const replyMarkup = savedSummaryKeyboard(miniAppUrl, telegramUserId, language);
  let text;
  if (Array.isArray(remainingExpenses) && remainingExpenses.length > 0) {
    const total = remainingExpenses.reduce((sum, expense) => sum + Number(expense.amount_base ?? 0), 0);
    text = formatSavedSummary(total, dashboardSnapshot ?? {}, { language, expenses: remainingExpenses });
  } else {
    text = botText(language, "expenseDeletedMessage");
  }
  await updateDraftMessageToSaved({ token, draft, text, replyMarkup, telegramClient });
}

export async function updatePlannedPaymentReminderMessages({
  token,
  reminders,
  outcome,
  source = "mini_app",
  telegramClient
}) {
  for (const reminder of reminders ?? []) {
    const language = reminder.interface_language === "ru" ? "ru" : "en";
    const text = outcome === "disabled"
      ? language === "ru"
        ? source === "telegram"
          ? "🔕 Плановая оплата отключена."
          : "🔕 Плановая оплата отключена в Mini App."
        : source === "telegram"
          ? "🔕 Planned payment disabled."
          : "🔕 Planned payment disabled in Mini App."
      : language === "ru"
        ? "✅ Оплата отмечена в Mini App."
        : "✅ Payment marked as paid in Mini App.";
    try {
      await editMessageText(
        token,
        reminder.tg_chat_id,
        reminder.tg_message_id,
        text,
        { inline_keyboard: [] },
        telegramClient
      );
    } catch (error) {
      console.warn("[planned-reminder] Mini App sync edit failed", {
        outcome,
        message: error?.message
      });
    }
  }
}

export async function updateDraftMessageToDraftState({ token, draft, items, miniAppUrl, telegramUserId, language, repository, user, telegramClient }) {
  const chatId = draft?.tg_chat_id;
  const messageId = draft?.tg_message_id;
  if (!chatId || !messageId) {
    console.log("[telegram] no stored message reference for draft", draft?.id);
    return;
  }
  const text = await renderDraftPreview({ repository, user, items: items ?? [], language });
  const replyMarkup = draftKeyboard(draft.id, items ?? [], miniAppUrl, telegramUserId, language);
  try {
    await editMessageText(token, chatId, messageId, text, replyMarkup, telegramClient);
  } catch (error) {
    if (isMessageNotModified(error)) return;
    console.error("[telegram] update draft message to draft state failed; sending fallback", error.message);
    try { await sendMessage(token, chatId, text, replyMarkup, telegramClient); }
    catch (sendError) { console.error("[telegram] fallback draft preview failed", sendError.message); }
    try { await editMessageReplyMarkup(token, chatId, messageId, { inline_keyboard: [] }, telegramClient); }
    catch (markupError) { console.error("[telegram] could not clear old draft keyboard", markupError.message); }
  }
}

export async function updateDraftMessageToCanceled({ token, draft, text, telegramClient }) {
  const chatId = draft?.tg_chat_id;
  const messageId = draft?.tg_message_id;
  if (!chatId || !messageId) return;
  try {
    await editMessageText(token, chatId, messageId, text, { inline_keyboard: [] }, telegramClient);
  } catch (error) {
    if (isMessageNotModified(error)) return;
    console.error("[telegram] update draft message to canceled failed; sending fallback", error.message);
    try { await sendMessage(token, chatId, text, { inline_keyboard: [] }, telegramClient); }
    catch (sendError) { console.error("[telegram] fallback canceled message failed", sendError.message); }
    try { await editMessageReplyMarkup(token, chatId, messageId, { inline_keyboard: [] }, telegramClient); }
    catch (markupError) { console.error("[telegram] could not clear old draft keyboard", markupError.message); }
  }
}

export function draftCanceledMessageText(language) {
  return botText(language, "draftCanceledMessage");
}

export function savedSummaryKeyboard(miniAppUrl, telegramUserId, language) {
  return appKeyboard(miniAppUrl, telegramUserId, language);
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
    if (isMessageNotModified(error)) {
      console.log("[telegram] editMessageText: message is not modified, ignoring");
      return { ok: true };
    }
    if (!shouldRetryPlainText(error)) throw error;
    console.error("[telegram] editMessageText HTML rejected, retrying plain text", error.message);
    return telegramRequest(token, "editMessageText", {
      ...body,
      text: stripTelegramHtml(text),
      parse_mode: undefined
    });
  }
}

async function editMessageReplyMarkup(token, chatId, messageId, replyMarkup, telegramClient) {
  if (telegramClient) return telegramClient.editMessageReplyMarkup?.({ chatId, messageId, replyMarkup });
  if (!token) {
    console.log("[telegram:editMessageReplyMarkup]", { chatId, messageId, replyMarkup });
    return { ok: true };
  }
  return telegramRequest(token, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
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
  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: isFormData ? undefined : { "content-type": "application/json" },
    body: isFormData ? body : JSON.stringify(cleanTelegramBody(body))
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

export function isMessageNotModified(error) {
  if (!error || error?.status !== 400) return false;
  const text = `${error.body ?? ""} ${error.message ?? ""}`;
  return /message is not modified/i.test(text);
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

function looksLikeNonExpenseIntent(text) {
  const source = String(text ?? "").trim();
  if (!source || !hasAmountToken(source)) return false;
  return [
    /(?<![\p{L}\p{N}])перев(?:еди|ел|ела|ести)(?![\p{L}\p{N}])[\s\S]*\d/iu,
    /(?<![\p{L}\p{N}])запланируй(?![\p{L}\p{N}])[\s\S]*\d/iu,
    /(?<![\p{L}\p{N}])отлож(?:и|ил|ила)(?![\p{L}\p{N}])[\s\S]*\d/iu,
    /(?<![\p{L}\p{N}])снял(?![\p{L}\p{N}])[\s\S]*(?<![\p{L}\p{N}])(?:со\s+сч[её]та|с\s+карты)(?![\p{L}\p{N}])[\s\S]*\d/iu,
    /^(?:please\s+)?transfer(?:\s+money)?\s+\d/iu,
    /\bsend(?:\s+money)?\b[\s\S]*\d/iu,
    /\bplanned\s+payment\b[\s\S]*\d/iu,
    /\breserve\b[\s\S]*\d/iu
  ].some((pattern) => pattern.test(source));
}

function hasAmountToken(text) {
  return /[$฿₽€₾]?\s*\d/u.test(text);
}

function nonExpenseGuardText(text) {
  if (!/[а-яё]/iu.test(String(text ?? ""))) {
    return "This does not look like a regular expense. Try: \"top up the budget 500\" or \"add 500 to budget\".";
  }
  return "Похоже, это не обычный расход — возможно, пополнение бюджета, плановая оплата или перевод. Попробуй: «пополни бюджет 500» или «добавь 500 к бюджету».";
}

function createPerfTrace({ update, logger }) {
  const startedAt = performance.now();
  const traceId = createTraceId();
  const messageType = resolveMessageType(update);
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

    elapsed() {
      return elapsedSince(startedAt);
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
      fallback: metadata.fallback,
      parserEngine: metadata.parserEngine,
      parserRoute: metadata.parserRoute,
      fallbackReason: metadata.fallbackReason,
      localFastPathAccepted: metadata.localFastPathAccepted,
      localFastPathRejectReason: metadata.localFastPathRejectReason,
      categoryResolution: metadata.categoryResolution,
      localAcceptanceLevel: metadata.localAcceptanceLevel,
      localCandidate: metadata.localCandidate,
      llmSkipped: metadata.llmSkipped,
      fastPathMode: metadata.fastPathMode,
      shadowDisagreement: metadata.shadowDisagreement,
      criticalShadowDisagreement: metadata.criticalShadowDisagreement,
      categoryOnlyShadowDisagreement: metadata.categoryOnlyShadowDisagreement,
      shadowDisagreementFields: metadata.shadowDisagreementFields,
      localParseMs: metadata.localParseMs,
      localEvaluateMs: metadata.localEvaluateMs,
      llmHttpMs: metadata.llmHttpMs,
      llmDecodeNormalizeMs: metadata.llmDecodeNormalizeMs,
      parserTotalMs: metadata.parserTotalMs
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
      budgetTopupParseFailed: "Не удалось безопасно разобрать пополнение бюджета. Напиши сумму ещё раз.",
      budgetTopupCancelled: "Ок, не учитываю это в бюджете.",
      budgetTopupExpired: "Это пополнение уже устарело. Напиши сумму ещё раз, и я добавлю её к бюджету.",
      budgetTopupReplacedByNewer: "Это пополнение уже не активно — есть более новое. Подтверди его кнопками ниже.",
      budgetTopupWrongMonth: "В MVP пополнения можно добавлять только к текущему месяцу. Для прошлого месяца это пополнение не сохранено.",
      budgetTopupUndoExpired: "Это пополнение уже нельзя отменить через кнопку. Открой Mini App или напиши мне, если нужно исправить бюджет.",
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
      draftCanceledMessage: "🗑 Черновик отменён, расход не сохранён",
      expenseDeletedMessage: "🗑 Запись удалена.\nРасход удалён из Mini App и больше не учитывается.",
      chooseCategoryAlert: "Сначала выберите категорию.",
      draftCanceledAlert: "Этот черновик уже отменён.",
      alreadySavedCallback: "Уже сохранено",
      editInMiniApp: "Редактирование доступно в Mini App.",
      exportChoosePeriod: "Экспорт расходов в CSV. Выбери период:",
      exportPreparingCallback: "Готовлю экспорт",
      expenseProcessing: `<tg-emoji emoji-id="${EXPENSE_PROCESSING_CUSTOM_EMOJI_ID}">🎲</tg-emoji> Заношу расход…`,
      draftSavingCallback: "Сохраняю…",
      draftSaveFailed: "⚠️ Не удалось сохранить расход. Попробуйте ещё раз.",
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
      budgetTopupParseFailed: "I could not safely parse this budget top-up. Send the amount again.",
      budgetTopupCancelled: "Okay, I will not count it in your budget.",
      budgetTopupExpired: "This budget top-up has expired. Send the amount again and I’ll add it to your budget.",
      budgetTopupReplacedByNewer: "This top-up is no longer active — there’s a newer one. Use the buttons on the most recent message.",
      budgetTopupWrongMonth: "For the MVP, budget top-ups can be added only to the current month. This previous-month top-up was not saved.",
      budgetTopupUndoExpired: "This top-up can no longer be undone from the button. Open the Mini App or message me if you need to fix the budget.",
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
      draftCanceledMessage: "🗑 Draft cancelled, expense not saved",
      expenseDeletedMessage: "🗑 Entry deleted.\nThis expense was deleted in Mini App and no longer counts.",
      chooseCategoryAlert: "Please choose a category first.",
      draftCanceledAlert: "This draft was canceled.",
      alreadySavedCallback: "Already saved",
      editInMiniApp: "Editing is available in Mini App.",
      exportChoosePeriod: "Export expenses to CSV. Choose a period:",
      exportPreparingCallback: "Preparing export",
      expenseProcessing: `<tg-emoji emoji-id="${EXPENSE_PROCESSING_CUSTOM_EMOJI_ID}">🎲</tg-emoji> Adding expense…`,
      draftSavingCallback: "Saving…",
      draftSaveFailed: "⚠️ Could not save this expense. Please try again.",
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
