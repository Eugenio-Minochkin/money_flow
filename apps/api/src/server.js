import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseAdminTelegramIds } from "./adminAccess.js";
import { createAdminAlertService } from "./adminAlerts.js";
import { config, requireRuntimeConfig } from "./config.js";
import { createAdminStatsService } from "./adminStatsService.js";
import { createApiSecurity } from "./apiSecurity.js";
import { recordClientStartupTiming } from "./clientStartupTiming.js";
import { migrate, pool } from "./db.js";
import { createDailyReminderService } from "./dailyReminderService.js";
import { confirmDraftForApi } from "./draftConfirmation.js";
import { createExchangeRateProvider } from "./exchangeRates.js";
import { createExpenseExportService } from "./expenseExportService.js";
import { createExpenseParser } from "./expenseParser.js";
import { createExpenseDraftFromText, ExpenseTextNotRecognizedError, ShortcutRequestInProgressError } from "./expenseDraftService.js";
import { createQuickAccessToken, hashQuickAccessToken } from "./quickAccessService.js";
import { processMiniAppQuickCapture } from "./quickCapture.js";
import { processShortcutCapture } from "./shortcutCapture.js";
import { createPaidProviderUsageGate } from "./paidProviderUsage.js";
import { acceptReviewRecovery, previewSmartSaveRecovery, saveSmartSaveRecovery } from "./smartSaveRecovery.js";
import { handleHealth } from "./health.js";
import { createJsonReader, createStaticHandler, sendJson } from "./http.js";
import { handleDevRoute } from "./devRoutes.js";
import { createMiniAppLaunchService } from "./miniAppLaunchService.js";
import { createPlannedPaymentReminderService } from "./plannedPaymentReminderService.js";
import { createRateLimiter, getRateLimitKey } from "./rateLimit.js";
import { createReleaseDigestScheduler } from "./releaseDigestScheduler.js";
import { createReleaseNotesService } from "./releaseNotesService.js";
import { createReportScheduler } from "./reportScheduler.js";
import { createReportService } from "./reportService.js";
import { readAppRevision } from "./revision.js";
import { DraftCanceledError, CategoryRequiredError, DraftNotFoundError, createRepository } from "./repository.js";
import { shouldRateLimitRequest } from "./routing.js";
import { createStartupTiming } from "./startupTiming.js";
import {
  createTelegramBot,
  deliverShortcutCaptureToTelegramBestEffort,
  draftCanceledMessageText,
  savedSummaryKeyboard,
  sendTelegramDocument,
  sendTelegramMessage,
  updateDraftMessageToCanceled,
  updateDraftMessageToDraftState,
  updateDraftMessageToSaved,
  updatePlannedPaymentReminderMessages,
  updateTelegramMessageAfterExpenseDelete
} from "./telegram.js";
import { syncTelegramCommandMenu, syncTelegramUserCommandMenu } from "./telegramCommands.js";
import { createVoiceTranscriber } from "./voiceTranscriber.js";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const webRoot = join(root, "apps", "miniapp", process.env.NODE_ENV === "production" ? "dist" : "src");
const appRevision = readAppRevision();
const readJson = createJsonReader({ maxJsonBytes: config.maxJsonBytes });
const serveStatic = createStaticHandler({ webRoot });
const apiSecurity = createApiSecurity({
  telegramBotToken: config.telegramBotToken,
  requireTelegramInitData: config.requireTelegramInitData,
  telegramWebhookSecret: config.telegramWebhookSecret
});

requireRuntimeConfig();
const adminTelegramIds = parseAdminTelegramIds(config.adminTelegramIds);
if (adminTelegramIds.size === 0) {
  console.warn("[admin] ADMIN_TELEGRAM_IDS is empty; admin commands are disabled");
}
const adminAlertService = createAdminAlertService({
  enabled: config.adminAlertsEnabled && Boolean(config.telegramBotToken),
  adminTelegramIds,
  sendMessage: (message) => sendTelegramMessage({
    token: config.telegramBotToken,
    ...message
  }),
  logger: console,
  throttleMs: config.adminAlertThrottleMs,
  maxMessageLength: config.adminAlertMaxMessageLength
});

await migrate();

const repository = createRepository(pool, {
  defaultMonthlyBudget: config.defaultMonthlyBudget,
  exchangeRates: createExchangeRateProvider({ pool, adminAlertService })
});
const miniAppLaunchService = createMiniAppLaunchService({
  repository,
  syncTelegramCommandMenu: syncUserTelegramCommandMenu
});
const adminStatsService = createAdminStatsService({ pool });
const expenseParser = createExpenseParser({
  apiKey: config.openAiApiKey,
  model: config.openAiModel,
  fastPathMode: config.expenseFastPathMode,
  localFirstRolloutPercent: config.expenseParserLocalFirstRolloutPercent,
  localFirstUserIds: config.expenseParserLocalFirstUserIds,
  maxLocalAmount: config.expenseParserMaxLocalAmount,
  llmTimeoutMs: config.expenseParserLlmTimeoutMs,
  llmEnabled: config.openAiParserGlobalEnabled,
  consumeLlmUsage: createPaidProviderUsageGate({
    repository,
    provider: "openai_parser",
    windowMs: config.paidAiWindowMs,
    maxRequests: config.openAiParserUserLimit,
    enabled: config.openAiParserGlobalEnabled
  }),
  parserTextHashSecret: config.parserTextHashSecret
});
const voiceTranscriber = createVoiceTranscriber({
  telegramBotToken: config.telegramBotToken,
  deepgramApiKey: config.deepgramApiKey,
  enabled: config.deepgramTranscriptionGlobalEnabled,
  maxAudioDurationSec: config.deepgramMaxAudioDurationSec,
  consumeVoiceUsage: createPaidProviderUsageGate({
    repository,
    provider: "deepgram_transcription",
    windowMs: config.paidAiWindowMs,
    maxRequests: config.deepgramTranscriptionUserLimit,
    maxAudioSeconds: config.deepgramMaxAudioWindowSec,
    enabled: config.deepgramTranscriptionGlobalEnabled
  })
});
const expenseExportService = createExpenseExportService({
  repository,
  sendDocument: (document) => sendTelegramDocument({
    token: config.telegramBotToken,
    ...document
  })
});
const releaseNotesService = createReleaseNotesService({
  repository,
  sendMessage: (message) => sendTelegramMessage({
    token: config.telegramBotToken,
    ...message
  })
});
if (config.releaseDigestAutoSendEnabled && !config.telegramBotToken) {
  console.warn("[release-digest] automatic sending is enabled but TELEGRAM_BOT_TOKEN is missing; scheduler is disabled");
}
const releaseDigestScheduler = createReleaseDigestScheduler({
  enabled: config.releaseDigestAutoSendEnabled && Boolean(config.telegramBotToken),
  timezone: config.releaseDigestTimezone,
  sendHour: config.releaseDigestSendHour,
  checkIntervalMinutes: config.releaseDigestCheckIntervalMinutes,
  repository,
  releaseNotesService,
  logger: console,
  onError(error) {
    console.error("[release-digest] scheduler failed", error);
    return safeNotifyAdminError(adminAlertService, error, {
      source: "scheduler",
      jobName: "release-digest",
      operation: "send_release_digest"
    });
  }
});
releaseDigestScheduler.start();
const dailyReminderService = createDailyReminderService({
  repository,
  sendMessage: (message) => sendTelegramMessage({
    token: config.telegramBotToken,
    ...message
  }),
  globalEnabled: config.dailyReminderGlobalEnabled,
  rolloutPercent: config.dailyReminderRolloutPercent
});
const plannedPaymentReminderService = createPlannedPaymentReminderService({
  repository,
  sendMessage: (message) => sendTelegramMessage({
    token: config.telegramBotToken,
    ...message
  }),
  globalEnabled: config.plannedPaymentReminderGlobalEnabled,
  sendHour: config.plannedPaymentReminderSendHour,
  miniAppUrl: config.miniAppUrl
});
const reportService = createReportService({
  repository,
  miniAppUrl: config.miniAppUrl,
  sendMessage: (message) => sendTelegramMessage({
    token: config.telegramBotToken,
    ...message
  })
});
const reportScheduler = createReportScheduler({
  enabled: Boolean(config.telegramBotToken),
  reportService,
  logger: console,
  adminAlertService
});
function createBot(telegramClient) {
  return createTelegramBot({
    repository,
    expenseParser,
    voiceTranscriber,
    token: config.telegramBotToken,
    miniAppUrl: config.miniAppUrl,
    adminTelegramIds,
    adminStatsService,
    releaseNotesService,
    adminAlertService,
    expenseExportService,
    telegramClient,
    awaitQueuedJobs: false,
    telegramJobQueueOptions: {
      globalConcurrency: config.telegramJobGlobalConcurrency,
      userQueueLimit: config.telegramJobUserQueueLimit,
      jobTimeoutMs: config.telegramJobTimeoutMs
    }
  });
}
const bot = createBot();
if (config.telegramBotToken) {
  void syncTelegramCommandMenu({ token: config.telegramBotToken })
    .catch((error) => console.error("[telegram] command menu sync failed", error.message));
}

async function syncUserTelegramCommandMenu({ chatId, language, onboardingStep }) {
  try {
    return await syncTelegramUserCommandMenu({
      token: config.telegramBotToken,
      chatId,
      language,
      onboardingStep
    });
  } catch (error) {
    console.warn("[telegram] user command menu sync failed", error.message);
    return { ok: false };
  }
}

const rateLimiter = createRateLimiter({
  limit: config.rateLimitMax,
  windowMs: config.rateLimitWindowMs,
  bucketTtlMs: config.rateLimitBucketTtlMs,
  cleanupIntervalMs: config.rateLimitCleanupIntervalMs
});
reportScheduler.start();
startDailyReminderScheduler();

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    if (error.statusCode) {
      return sendJson(res, error.statusCode, { error: error.message });
    }
    if (["paid_provider_limit_reached", "paid_provider_disabled"].includes(error?.code)) {
      return sendJson(res, 429, { error: error.code });
    }
    console.error(error);
    void safeNotifyAdminError(adminAlertService, error, {
      source: "api",
      method: req.method,
      route: routePath(req)
    });
    sendJson(res, 500, { error: "internal_error" });
  }
});

server.listen(config.port, () => {
  console.log(`Money Flow API listening on http://localhost:${config.port}`);
});

function startDailyReminderScheduler() {
  if (
    !config.telegramBotToken
    || (!config.dailyReminderGlobalEnabled && !config.plannedPaymentReminderGlobalEnabled)
  ) return;
  const run = async () => {
    try {
      await plannedPaymentReminderService.runOnce();
    } catch (error) {
      console.error("[planned-payment-reminder] failed", error);
      void safeNotifyAdminError(adminAlertService, error, {
        source: "scheduler",
        jobName: "planned-payment-reminder",
        operation: "run_once"
      });
    }
    try {
      await dailyReminderService.runOnce();
    } catch (error) {
      console.error("[daily-reminder] failed", error);
      void safeNotifyAdminError(adminAlertService, error, {
        source: "scheduler",
        jobName: "daily-reminder",
        operation: "run_once"
      });
    }
  };
  setTimeout(run, 15_000);
  setInterval(run, Math.max(config.dailyReminderIntervalMs, 60_000));
}

async function safeNotifyAdminError(adminAlertService, error, context) {
  if (error?.adminAlertSent) return;
  await adminAlertService.notifyAdminError(error, context).catch((alertError) => {
    console.error("[admin-alerts] notify failed", alertError.message);
  });
}

async function syncPlannedPaymentReminderMessages(plannedExpenseId, occurrenceDate, outcome) {
  if (outcome === "paid" && !occurrenceDate) return;
  try {
    const reminders = await repository.listOutstandingPlannedPaymentReminders(
      plannedExpenseId,
      occurrenceDate
    );
    await updatePlannedPaymentReminderMessages({
      token: config.telegramBotToken,
      reminders,
      outcome
    });
    for (const reminder of reminders) {
      await repository.markPlannedPaymentReminderTerminal(
        plannedExpenseId,
        String(reminder.occurrence_date).slice(0, 10),
        outcome
      );
    }
  } catch (error) {
    console.warn("[planned-reminder] Mini App sync failed after commit", {
      outcome,
      message: error?.message
    });
  }
}

function routePath(req) {
  try {
    return new URL(req.url, `http://${req.headers.host}`).pathname;
  } catch {
    return req.url ?? "unknown";
  }
}

function bearerToken(req) {
  const value = String(req.headers.authorization ?? "");
  const match = /^Bearer ([A-Za-z0-9_-]{43,})$/.exec(value);
  return match?.[1] ?? null;
}

function isClientRequestId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function accountDeletionStatusResponse(result) {
  const response = {
    status: result.status,
    stage: result.stage
  };
  const expiresAt = toIsoString(result.expiresAt);
  if (expiresAt) response.expiresAt = expiresAt;
  return response;
}

function toIsoString(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function accountDeletionErrorStatus(error) {
  if (["invalid_account_deletion_source", "invalid_account_deletion_confirmation"].includes(error.code)) return 400;
  if (error.code === "account_deletion_expired") return 410;
  if ([
    "account_deletion_already_pending",
    "account_deletion_not_pending"
  ].includes(error.code)) return 409;
  if (error.code === "user_not_found") return 404;
  return null;
}

function draftConfirmErrorResponse(error) {
  if (error instanceof DraftCanceledError) return { statusCode: 409, error: "draft_canceled" };
  if (error instanceof DraftNotFoundError) return { statusCode: 404, error: "draft_not_found" };
  if (error instanceof CategoryRequiredError) return { statusCode: 422, error: "category_required" };
  if (error?.code === "expense_source_month_closed") return { statusCode: 409, error: error.code };
  if ([
    "expense_invalid_amount",
    "expense_invalid_currency",
    "expense_invalid_date",
    "expense_future_date",
    "expense_operation_not_supported"
  ].includes(error?.code)) return { statusCode: 422, error: error.code };
  return null;
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (await handleDevRoute({ req, res, url, readJson, repository, createBot, serveStatic })) {
    return;
  }

  if (shouldRateLimitRequest(req, url)) {
    const rateLimitIdentity = apiSecurity.resolveTelegramUserId(req, url);
    const rate = rateLimiter.check(getRateLimitKey(req, {
      telegramUserId: rateLimitIdentity.telegramUserId,
      trustedProxyIps: config.trustedProxyIps
    }));
    if (!rate.allowed) {
      res.setHeader("retry-after", String(rate.retryAfterSeconds));
      return sendJson(res, 429, { error: "rate_limited", retryAfterSeconds: rate.retryAfterSeconds });
    }
  }

  if (req.method === "POST" && url.pathname === "/telegram/webhook") {
    if (!apiSecurity.isValidTelegramWebhook(req)) return sendJson(res, 401, { error: "invalid_webhook_secret" });
    const update = await readJson(req);
    await bot.handleUpdate(update);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/startup-timing") {
    const body = await readJson(req);
    const auth = apiSecurity.resolveVerifiedTelegramUserId(req);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const timings = recordClientStartupTiming(body.timings);
    if (!timings) return sendJson(res, 400, { error: "invalid_startup_timings" });
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/dashboard") {
    const timing = createStartupTiming();
    const deferred = [];
    const defer = (operation) => deferred.push(operation);
    const runDeferred = () => {
      const operations = deferred.splice(0);
      queueMicrotask(async () => {
        for (const operation of operations) await operation();
      });
    };
    res.once("finish", runDeferred);
    const sendDashboard = (status, body) => {
      timing.finish({ route: "/api/dashboard", status });
      res.setHeader("server-timing", timing.serverTiming());
      return sendJson(res, status, body);
    };
    try {
      const auth = await timing.measure("auth", () => apiSecurity.resolveTelegramUserId(req, url));
      if (auth.error) return sendDashboard(400, { error: auth.error });
      const telegramUserId = auth.telegramUserId;
      const timeZone = req.headers["x-user-timezone"];
      if (auth.verified) {
        const dashboard = await miniAppLaunchService.loadDashboard({
          auth,
          reportType: url.searchParams.get("reportType"),
          reportKey: url.searchParams.get("reportKey"),
          timeZone,
          timing,
          defer
        });
        if (!dashboard) return sendDashboard(404, { error: "user_not_found" });
        return sendDashboard(200, dashboard);
      }
      if (timeZone) await timing.measure("timezone_sync", () => repository.syncUserTimezone(telegramUserId, timeZone));
      const dashboard = await timing.measure("repository_dashboard", () => repository.dashboard(telegramUserId, undefined, timing));
      if (!dashboard) return sendDashboard(404, { error: "user_not_found" });
      return sendDashboard(200, dashboard);
    } catch (error) {
      timing.finish({ route: "/api/dashboard", status: error.statusCode ?? 500 });
      if (!res.headersSent) res.setHeader("server-timing", timing.serverTiming());
      throw error;
    }
  }

  if (req.method === "PUT" && url.pathname === "/api/reserve/current") {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    try {
      const result = await repository.upsertCurrentReserve(auth.telegramUserId, body.reserve ?? {});
      if (!result) return sendJson(res, 404, { error: "user_not_found" });
      return sendJson(res, 200, result);
    } catch (error) {
      if (error.code === "reserve_exceeds_free_budget") {
        return sendJson(res, 409, { error: error.code });
      }
      throw error;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/reserve/current/disable") {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const result = await repository.disableCurrentReserve(
      auth.telegramUserId,
      body.scope ?? "current"
    );
    if (!result) return sendJson(res, 404, { error: "user_not_found" });
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/reserve-events/ack") {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const events = await repository.ackReserveEvents(auth.telegramUserId, body.eventIds ?? []);
    return sendJson(res, 200, { events });
  }

  if (req.method === "GET" && url.pathname === "/api/expenses") {
    const auth = apiSecurity.resolveTelegramUserId(req, url);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const fromDate = url.searchParams.get("fromDate") ?? "";
    const toDate = url.searchParams.get("toDate") ?? "";
    if (fromDate && toDate) {
      const fromMs = Date.parse(`${fromDate}T00:00:00`);
      const toMs = Date.parse(`${toDate}T00:00:00`);
      if (Number.isNaN(fromMs) || Number.isNaN(toMs) || new Date(fromMs) > new Date(toMs)) {
        return sendJson(res, 400, { error: "invalid_date_range" });
      }
    }
    const expenses = await repository.listExpensesForTelegramUser(auth.telegramUserId, {
      period: url.searchParams.get("period") ?? "month",
      fromDate,
      toDate,
      search: url.searchParams.get("search") ?? ""
    });
    return sendJson(res, 200, { expenses });
  }

  if (req.method === "GET" && url.pathname === "/api/drafts") {
    const auth = apiSecurity.resolveTelegramUserId(req, url);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const drafts = await repository.listDraftsForTelegramUser(auth.telegramUserId, {
      status: url.searchParams.get("status") ?? "inbox"
    });
    return sendJson(res, 200, { drafts });
  }

  if (req.method === "GET" && url.pathname === "/api/drafts/recovery-preview") {
    const auth = apiSecurity.resolveTelegramUserId(req, url);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const preview = await previewSmartSaveRecovery({ telegramUserId: auth.telegramUserId, repository });
    if (!preview) return sendJson(res, 404, { error: "user_not_found" });
    return sendJson(res, 200, preview);
  }

  if (req.method === "POST" && url.pathname === "/api/drafts/recovery-save") {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const result = await saveSmartSaveRecovery({
      telegramUserId: auth.telegramUserId,
      draftIds: body.draftIds,
      repository
    });
    if (!result) return sendJson(res, 404, { error: "user_not_found" });
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/drafts/recovery-accept") {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const result = await acceptReviewRecovery({
      telegramUserId: auth.telegramUserId,
      draftIds: body.draftIds,
      repository
    });
    if (!result) return sendJson(res, 404, { error: "user_not_found" });
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/quick-entry") {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const user = await repository.getUserByTelegramId(auth.telegramUserId);
    if (!user) return sendJson(res, 404, { error: "user_not_found" });
    if (!isClientRequestId(body.clientRequestId)) return sendJson(res, 400, { error: "invalid_client_request_id" });
    try {
      const result = await processMiniAppQuickCapture({ user, clientRequestId: body.clientRequestId, text: body.text, expenseParser, repository });
      if (!result) return sendJson(res, 409, { error: "quick_capture_request_in_progress" });
      if (!result.replayed) await repository.recordAppEvent?.(user.id, "quick_entry_submitted", { source: "miniapp" });
      if (result.saved) {
        if (!result.saved.alreadySaved) await repository.recordAppEvent?.(user.id, "quick_entry_confirmed", { source: "miniapp" });
        return sendJson(res, result.replayed ? 200 : 201, { saved: result.saved });
      }
      return sendJson(res, result.replayed ? 200 : 201, { draft: result.draft });
    } catch (error) {
      if (error instanceof ExpenseTextNotRecognizedError) return sendJson(res, 422, { error: error.code });
      if (error instanceof ShortcutRequestInProgressError) return sendJson(res, 409, { error: error.code });
      throw error;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/quick-access-token-preparations") {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const user = await repository.getUserByTelegramId(auth.telegramUserId);
    if (!user) return sendJson(res, 404, { error: "user_not_found" });
    const { token, tokenHash } = createQuickAccessToken();
    const prepared = await repository.prepareQuickAccessToken(user.id, tokenHash);
    return sendJson(res, 201, { preparationId: prepared.id, token });
  }

  const quickAccessPreparationMatch = url.pathname.match(/^\/api\/quick-access-token-preparations\/(\d+)\/activate$/);
  if (req.method === "POST" && quickAccessPreparationMatch) {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const user = await repository.getUserByTelegramId(auth.telegramUserId);
    if (!user) return sendJson(res, 404, { error: "user_not_found" });
    const activation = await repository.activatePreparedQuickAccessToken(user.id, Number(quickAccessPreparationMatch[1]));
    if (!['activated', 'active'].includes(activation.state)) return sendJson(res, 409, { error: `quick_access_preparation_${activation.state}` });
    if (activation.state === "activated") await repository.recordAppEvent?.(user.id, "quick_access_token_activated", {});
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/quick-access-tokens") {
    return sendJson(res, 410, { error: "quick_access_prepare_required" });
  }

  if (req.method === "GET" && url.pathname === "/api/quick-access") {
    const auth = apiSecurity.resolveTelegramUserId(req, url);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const user = await repository.getUserByTelegramId(auth.telegramUserId);
    if (!user) return sendJson(res, 404, { error: "user_not_found" });
    const status = await repository.getQuickAccessStatus(user.id);
    return sendJson(res, 200, {
      iosShortcutUrl: config.iosShortcutUrl || null,
      shortcutConfigured: status.configured,
      lastUsedAt: toIsoString(status.lastUsedAt)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/quick-access/events") {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const user = await repository.getUserByTelegramId(auth.telegramUserId);
    const eventName = String(body.eventName ?? "");
    if (!user || !["quick_entry_opened", "quick_entry_canceled", "home_screen_prompted", "home_screen_added"].includes(eventName)) {
      return sendJson(res, 400, { error: "invalid_quick_access_event" });
    }
    await repository.recordAppEvent?.(user.id, eventName, {});
    return sendJson(res, 204, {});
  }

  if (req.method === "DELETE" && url.pathname === "/api/quick-access-tokens") {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const user = await repository.getUserByTelegramId(auth.telegramUserId);
    if (!user) return sendJson(res, 404, { error: "user_not_found" });
    await repository.revokeQuickAccessTokens(user.id);
    await repository.recordAppEvent?.(user.id, "quick_access_token_revoked", {});
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/shortcut/expenses") {
    const body = await readJson(req);
    const rawToken = bearerToken(req);
    if (!rawToken) return sendJson(res, 401, { error: "quick_access_unauthorized" });
    const user = await repository.findQuickAccessToken(hashQuickAccessToken(rawToken));
    if (!user) return sendJson(res, 401, { error: "quick_access_unauthorized" });
    if (!isClientRequestId(body.clientRequestId)) return sendJson(res, 400, { error: "invalid_client_request_id" });
    try {
      const result = await processShortcutCapture({ user, tokenId: user.token_id, clientRequestId: body.clientRequestId, text: body.text, expenseParser, repository });
      if (!result) return sendJson(res, 401, { error: "quick_access_unauthorized" });
      if (!result.replayed) {
        await deliverShortcutCaptureToTelegramBestEffort({
          result,
          user,
          repository,
          token: config.telegramBotToken,
          miniAppUrl: config.miniAppUrl,
          onError(error) {
          console.error("[shortcut] Telegram delivery failed", error.message);
          void safeNotifyAdminError(adminAlertService, error, { source: "shortcut", operation: "telegram_delivery", userId: user.id });
          }
        });
      }
      if (!result.replayed) await repository.recordAppEvent?.(user.id, "quick_entry_submitted", { source: "ios_shortcut" });
      if (result.state === "saved" && !result.alreadySaved) {
        await repository.recordAppEvent?.(user.id, "quick_entry_confirmed", { source: "ios_shortcut" });
      }
      return sendJson(res, result.replayed ? 200 : 201, result);
    } catch (error) {
      if (error instanceof ExpenseTextNotRecognizedError) return sendJson(res, 422, { error: error.code });
      if (error instanceof ShortcutRequestInProgressError) return sendJson(res, 409, { error: error.code });
      throw error;
    }
  }

  const shortcutConfirmMatch = url.pathname.match(/^\/api\/shortcut\/drafts\/(\d+)\/confirm$/);
  if (req.method === "POST" && shortcutConfirmMatch) {
    const rawToken = bearerToken(req);
    if (!rawToken) return sendJson(res, 401, { error: "quick_access_unauthorized" });
    const user = await repository.findQuickAccessToken(hashQuickAccessToken(rawToken));
    if (!user) return sendJson(res, 401, { error: "quick_access_unauthorized" });
    const draftId = Number(shortcutConfirmMatch[1]);
    const draft = await repository.getDraftForTelegramUser(draftId, user.telegram_user_id);
    if (!draft) return sendJson(res, 404, { error: "draft_not_found" });
    try {
      const result = await repository.confirmDraftWithExplicitAcceptance(draftId, user.telegram_user_id);
      await repository.recordAppEvent?.(user.id, "quick_entry_confirmed", { source: "ios_shortcut" });
      return sendJson(res, 200, result);
    } catch (error) {
      const response = draftConfirmErrorResponse(error);
      if (response) return sendJson(res, response.statusCode, { error: response.error });
      throw error;
    }
  }

  const shortcutCancelMatch = url.pathname.match(/^\/api\/shortcut\/drafts\/(\d+)\/cancel$/);
  if (req.method === "POST" && shortcutCancelMatch) {
    const rawToken = bearerToken(req);
    if (!rawToken) return sendJson(res, 401, { error: "quick_access_unauthorized" });
    const user = await repository.findQuickAccessToken(hashQuickAccessToken(rawToken));
    if (!user) return sendJson(res, 401, { error: "quick_access_unauthorized" });
    const draftId = Number(shortcutCancelMatch[1]);
    const draft = await repository.getDraftForTelegramUser(draftId, user.telegram_user_id);
    if (!draft) return sendJson(res, 404, { error: "draft_not_found" });
    const result = await repository.cancelDraft(draftId, user.telegram_user_id);
    await repository.recordAppEvent?.(user.id, "quick_entry_canceled", { source: "ios_shortcut" });
    return sendJson(res, 200, result);
  }

  if (req.method === "GET" && url.pathname === "/api/planned-expenses") {
    const auth = apiSecurity.resolveTelegramUserId(req, url);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const telegramUserId = auth.telegramUserId;
    const plannedExpenses = await repository.listPlannedExpensesForTelegramUser(telegramUserId);
    if (process.env.DEBUG_PLANNED === "1") {
      for (const item of plannedExpenses) {
        console.log("[planned-debug]", {
          id: item.id,
          description: item.description,
          recurrence: item.recurrence,
          due_day: item.due_day,
          due_days: item.due_days,
          weekday: item.weekday,
          due_date: item.due_date,
          active: item.active,
          paid_count: item.paid_count,
          paid_occurrence_dates: item.paid_occurrence_dates,
          paid_occurrences: item.paid_occurrences
        });
      }
    }
    return sendJson(res, 200, { plannedExpenses });
  }

  if (req.method === "GET" && url.pathname === "/api/planned-expenses/archive") {
    const auth = apiSecurity.resolveTelegramUserId(req, url);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const archivedPlannedExpenses = await repository.listArchivedPlannedExpensesForTelegramUser(auth.telegramUserId);
    return sendJson(res, 200, { archivedPlannedExpenses });
  }

  if (req.method === "POST" && url.pathname === "/api/planned-expenses") {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    let plannedExpense;
    try {
      plannedExpense = await repository.createPlannedExpense(auth.telegramUserId, body.plannedExpense);
    } catch (error) {
      if (error.code === "reserve_conflicts_with_planned_change") {
        return sendJson(res, 409, { error: error.code });
      }
      throw error;
    }
    if (!plannedExpense) return sendJson(res, 404, { error: "user_not_found" });
    return sendJson(res, 201, { plannedExpense });
  }

  const recreateMatch = url.pathname.match(/^\/api\/planned-expenses\/(\d+)\/recreate$/);
  if (req.method === "POST" && recreateMatch) {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    try {
      const plannedExpense = await repository.recreatePlannedExpense(
        auth.telegramUserId,
        Number(recreateMatch[1]),
        body.plannedExpense,
        body.startsOn
      );
      if (!plannedExpense) return sendJson(res, 404, { error: "planned_expense_not_found" });
      return sendJson(res, 201, { plannedExpense });
    } catch (error) {
      if ([
        "invalid_planned_start_date",
        "planned_start_date_in_past",
        "invalid_planned_due_date",
        "planned_due_date_before_start"
      ].includes(error.code)) {
        return sendJson(res, 400, { error: error.code });
      }
      if (error.code === "reserve_conflicts_with_planned_change") {
        return sendJson(res, 409, { error: error.code });
      }
      throw error;
    }
  }

  const plannedPaymentUndoMatch = url.pathname.match(/^\/api\/planned-expenses\/(\d+)\/payments\/([^/]+)$/);
  if (plannedPaymentUndoMatch && req.method === "DELETE") {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    try {
      const result = await repository.undoPlannedExpensePaymentForTelegramUser(
        Number(plannedPaymentUndoMatch[1]),
        auth.telegramUserId,
        plannedPaymentUndoMatch[2]
      );
      return sendJson(res, 200, result);
    } catch (error) {
      if (error.code === "invalid_occurrence") return sendJson(res, 400, { error: error.code });
      if (error.code === "planned_expense_not_found") return sendJson(res, 404, { error: error.code });
      if (["planned_payment_inconsistent", "planned_payment_undo_blocked"].includes(error.code)) {
        return sendJson(res, 409, { error: error.code });
      }
      throw error;
    }
  }

  const plannedMatch = url.pathname.match(/^\/api\/planned-expenses\/(\d+)$/);
  if (plannedMatch && (req.method === "PATCH" || req.method === "DELETE")) {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    if (req.method === "PATCH") {
      try {
        const plannedExpense = await repository.updatePlannedExpense(
          auth.telegramUserId,
          Number(plannedMatch[1]),
          body.plannedExpense
        );
        if (!plannedExpense) return sendJson(res, 404, { error: "planned_expense_not_found" });
        return sendJson(res, 200, { plannedExpense });
      } catch (error) {
        if (error.code === "reserve_conflicts_with_planned_change") {
          return sendJson(res, 409, { error: error.code });
        }
        throw error;
      }
    }

    const result = await repository.deactivatePlannedExpense(auth.telegramUserId, Number(plannedMatch[1]));
    if (!result) return sendJson(res, 404, { error: "planned_expense_not_found" });
    await syncPlannedPaymentReminderMessages(Number(plannedMatch[1]), null, "disabled");
    return sendJson(res, 200, result);
  }

  if (req.method === "PATCH" && url.pathname === "/api/settings/budget") {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    let user;
    try {
      user = await repository.updateMonthlyBudget(auth.telegramUserId, Number(body.monthlyBudgetAmount));
    } catch (error) {
      if (error.code === "reserve_conflicts_with_budget_change") {
        return sendJson(res, 409, { error: error.code, details: error.details });
      }
      throw error;
    }
    if (!user) return sendJson(res, 404, { error: "user_not_found" });
    return sendJson(res, 200, { user });
  }

  if (req.method === "PATCH" && url.pathname === "/api/settings/current-month-budget") {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    let currentMonthBudget;
    try {
      currentMonthBudget = await repository.setCurrentMonthBudget(auth.telegramUserId, {
        amount: Number(body.currentMonthBudgetAmount),
        currency: body.currency,
        source: "manual",
        isPartialMonth: true
      });
    } catch (error) {
      if (error.code === "reserve_conflicts_with_budget_change") {
        return sendJson(res, 409, { error: error.code, details: error.details });
      }
      throw error;
    }
    if (!currentMonthBudget) return sendJson(res, 404, { error: "user_not_found" });
    return sendJson(res, 200, { currentMonthBudget });
  }

  if (req.method === "PATCH" && url.pathname === "/api/settings") {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    let user;
    try {
      user = await repository.updateUserSettings(auth.telegramUserId, body.settings ?? {});
    } catch (error) {
      if (["reserve_conflicts_with_budget_change", "reserve_blocks_base_currency_change"].includes(error.code)) {
        return sendJson(res, 409, { error: error.code, details: error.details });
      }
      if (error.code === "unsupported_currency") return sendJson(res, 400, { error: error.code });
      throw error;
    }
    if (!user) return sendJson(res, 404, { error: "user_not_found" });
    await syncUserTelegramCommandMenu({
      chatId: auth.telegramUserId,
      language: user.interface_language,
      onboardingStep: user.onboarding_step
    });
    return sendJson(res, 200, { user });
  }

  if (req.method === "POST" && url.pathname === "/api/exports/expenses") {
    const body = await readJson(req);
    const auth = apiSecurity.resolveVerifiedTelegramUserId(req);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const user = await repository.getUserByTelegramId(auth.telegramUserId);
    if (!user) return sendJson(res, 404, { error: "user_not_found" });
    const result = await expenseExportService.requestExport({
      telegramUserId: auth.telegramUserId,
      chatId: auth.telegramUserId,
      period: body.period === "all" ? "all" : "month",
      language: user.interface_language ?? "en"
    });
    return sendJson(res, result.status === "throttled" ? 429 : 200, {
      status: result.status,
      message: result.message,
      filename: result.filename
    });
  }

  if (req.method === "POST" && url.pathname === "/api/account-deletion/request") {
    const body = await readJson(req);
    if (body.source !== "miniapp") return sendJson(res, 400, { error: "invalid_account_deletion_source" });
    const auth = apiSecurity.resolveVerifiedTelegramUserId(req);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    try {
      const result = await repository.requestAccountDeletion(auth.telegramUserId, { source: "miniapp" });
      if (!result) return sendJson(res, 404, { error: "user_not_found" });
      return sendJson(res, 200, accountDeletionStatusResponse(result));
    } catch (error) {
      const status = accountDeletionErrorStatus(error);
      if (status) return sendJson(res, status, { error: error.code });
      throw error;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/account-deletion/advance") {
    const body = await readJson(req);
    if (body.source !== "miniapp") return sendJson(res, 400, { error: "invalid_account_deletion_source" });
    const auth = apiSecurity.resolveVerifiedTelegramUserId(req);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    try {
      const result = await repository.advanceAccountDeletion(auth.telegramUserId, { source: "miniapp" });
      if (!result) return sendJson(res, 409, { error: "account_deletion_not_pending" });
      return sendJson(res, 200, accountDeletionStatusResponse(result));
    } catch (error) {
      const status = accountDeletionErrorStatus(error);
      if (status) return sendJson(res, status, { error: error.code });
      throw error;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/account-deletion/cancel") {
    const body = await readJson(req);
    if (body.source !== "miniapp") return sendJson(res, 400, { error: "invalid_account_deletion_source" });
    const auth = apiSecurity.resolveVerifiedTelegramUserId(req);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    try {
      await repository.cancelAccountDeletion(auth.telegramUserId, { source: "miniapp" });
      return sendJson(res, 200, { status: "cancelled" });
    } catch (error) {
      const status = accountDeletionErrorStatus(error);
      if (status) return sendJson(res, status, { error: error.code });
      throw error;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/account-deletion/confirm") {
    const body = await readJson(req);
    if (body.source !== "miniapp") return sendJson(res, 400, { error: "invalid_account_deletion_source" });
    const auth = apiSecurity.resolveVerifiedTelegramUserId(req);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    try {
      await repository.confirmAccountDeletion({ telegramUserId: auth.telegramUserId, source: "miniapp", confirmationText: body.confirmationText });
      return sendJson(res, 200, { status: "deleted" });
    } catch (error) {
      const status = accountDeletionErrorStatus(error);
      if (status) return sendJson(res, status, { error: error.code });
      throw error;
    }
  }

  const plannedPayMatch = url.pathname.match(/^\/api\/planned-expenses\/(\d+)\/pay$/);
  if (plannedPayMatch && req.method === "POST") {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    try {
      const expense = await repository.payPlannedExpenseForTelegramUser(
        Number(plannedPayMatch[1]),
        auth.telegramUserId,
        body.paidAt ? new Date(body.paidAt) : new Date(),
        { occurrenceDate: body.occurrenceDate }
      );
      await syncPlannedPaymentReminderMessages(
        Number(plannedPayMatch[1]),
        body.occurrenceDate,
        "paid"
      );
      return sendJson(res, 200, { expense });
    } catch (error) {
      if (error.code === "not_found") return sendJson(res, 404, { error: "planned_expense_not_found" });
      if (error.code === "already_paid") return sendJson(res, 409, { error: "planned_expense_already_paid" });
      if (error.code === "invalid_occurrence") return sendJson(res, 400, { error: "invalid_occurrence" });
      if (error.code === "future_occurrence") return sendJson(res, 400, { error: "future_occurrence" });
      console.error("[planned-pay] failed", {
        plannedExpenseId: plannedPayMatch[1],
        telegramUserId: auth.telegramUserId,
        paidAt: body.paidAt,
        occurrenceDate: body.occurrenceDate,
        code: error.code,
        message: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  const draftMatch = url.pathname.match(/^\/api\/drafts\/(\d+)(\/confirm)?$/);
  if (draftMatch) {
    const draftId = Number(draftMatch[1]);
    if (req.method === "GET" && !draftMatch[2]) {
      const auth = apiSecurity.resolveTelegramUserId(req, url);
      if (auth.error) return sendJson(res, 400, { error: auth.error });
      const telegramUserId = auth.telegramUserId;
      const draft = await repository.getDraftForTelegramUser(draftId, telegramUserId);
      if (!draft) return sendJson(res, 404, { error: "draft_not_found" });
      return sendJson(res, 200, { draft });
    }

    if (req.method === "PATCH" && !draftMatch[2]) {
      const body = await readJson(req);
      const auth = apiSecurity.resolveTelegramUserId(req, url, body);
      if (auth.error) return sendJson(res, 400, { error: auth.error });
      const expectedVersion = Number.isFinite(Number(body.expectedVersion)) ? Number(body.expectedVersion) : null;
      const draft = await repository.updateDraftItems(draftId, auth.telegramUserId, body.items ?? [], { expectedVersion });
      if (!draft) {
        const fresh = await repository.getDraftForTelegramUser(draftId, auth.telegramUserId);
        if (fresh && (fresh.status === "pending" || fresh.status === "inbox")) {
          console.warn("[server] draft version conflict", { draftId });
          return sendJson(res, 409, { error: "draft_version_conflict", draft: fresh });
        }
        return sendJson(res, 404, { error: "draft_not_found" });
      }
      const user = await repository.getUserByTelegramId(auth.telegramUserId).catch(() => null);
      if (user) {
        await updateDraftMessageToDraftState({
          token: config.telegramBotToken,
          draft,
          items: draft.items ?? [],
          miniAppUrl: config.miniAppUrl,
          telegramUserId: auth.telegramUserId,
          language: user.interface_language ?? "en",
          repository,
          user,
          telegramClient: null
        }).catch((error) => console.error("[server] draft preview update failed", error.message));
      }
      return sendJson(res, 200, { draft });
    }

    if (req.method === "DELETE" && !draftMatch[2]) {
      const body = await readJson(req);
      const auth = apiSecurity.resolveTelegramUserId(req, url, body);
      if (auth.error) return sendJson(res, 400, { error: auth.error });
      const outcome = await repository.cancelDraft(draftId, auth.telegramUserId);
      if (outcome.canceled) {
        const draft = await repository.getDraftForTelegramUser(draftId, auth.telegramUserId);
        if (draft) {
          await updateDraftMessageToCanceled({ token: config.telegramBotToken, draft, text: draftCanceledMessageText(body.language ?? "en"), telegramClient: null })
            .catch((error) => console.error("[server] cancel message update failed", error.message));
        }
      }
      return sendJson(res, 200, { ok: true, ...outcome });
    }

    if (req.method === "POST" && draftMatch[2]) {
      const body = await readJson(req);
      const auth = apiSecurity.resolveTelegramUserId(req, url, body);
      if (auth.error) return sendJson(res, 400, { error: auth.error });
      const language = body.language ?? "en";
      try {
        const response = await confirmDraftForApi({
          repository,
          draftId,
          telegramUserId: auth.telegramUserId,
          language,
          token: config.telegramBotToken,
          miniAppUrl: config.miniAppUrl,
          updateDraftMessageToSaved,
          savedSummaryKeyboard,
          telegramClient: null
        });
        return sendJson(res, response.statusCode, response.body);
      } catch (error) {
        const response = draftConfirmErrorResponse(error);
        if (response) return sendJson(res, response.statusCode, { error: response.error });
        throw error;
      }
    }
  }

  const expenseMatch = url.pathname.match(/^\/api\/expenses\/(\d+)$/);
  if (expenseMatch && (req.method === "PATCH" || req.method === "DELETE")) {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const expense = req.method === "PATCH"
      ? await repository.updateExpenseForTelegramUser(Number(expenseMatch[1]), auth.telegramUserId, body.expense)
      : await repository.deleteExpenseForTelegramUser(Number(expenseMatch[1]), auth.telegramUserId);
    if (!expense) return sendJson(res, 404, { error: "expense_not_found" });
    if (req.method === "DELETE" && expense.draft_id) {
      try {
        const draft = await repository.getDraftForTelegramUser(expense.draft_id, auth.telegramUserId);
        if (draft?.tg_chat_id && draft?.tg_message_id) {
          const remaining = await repository.listExpensesByDraftId(expense.draft_id);
          const { snapshot } = await repository.dashboard(auth.telegramUserId);
          await updateTelegramMessageAfterExpenseDelete({
            token: config.telegramBotToken,
            draft,
            remainingExpenses: remaining,
            dashboardSnapshot: snapshot,
            language: body.language ?? "en",
            miniAppUrl: config.miniAppUrl,
            telegramUserId: auth.telegramUserId,
            telegramClient: null
          }).catch((error) => console.error("[server] expense delete message update failed", error.message));
        }
      } catch (error) {
        console.error("[server] expense delete telegram sync failed", error.message);
      }
    }
    return sendJson(res, 200, { expense });
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return handleHealth({
      repository,
      revision: appRevision,
      isProduction: process.env.NODE_ENV === "production",
      res,
      sendJson
    });
  }

  if (req.method === "GET") {
    return serveStatic(res, url.pathname === "/" ? "/index.html" : url.pathname, {
      searchParams: url.searchParams,
      requestHeaders: req.headers
    });
  }

  sendJson(res, 404, { error: "not_found" });
}
