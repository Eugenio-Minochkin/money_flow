import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseAdminTelegramIds } from "./adminAccess.js";
import { config, requireRuntimeConfig } from "./config.js";
import { createAdminStatsService } from "./adminStatsService.js";
import { createApiSecurity } from "./apiSecurity.js";
import { migrate, pool } from "./db.js";
import { createDailyReminderService } from "./dailyReminderService.js";
import { createExchangeRateProvider } from "./exchangeRates.js";
import { createExpenseParser } from "./expenseParser.js";
import { createJsonReader, createStaticHandler, sendJson } from "./http.js";
import { handleDevRoute } from "./devRoutes.js";
import { createRateLimiter } from "./rateLimit.js";
import { createReleaseDigestScheduler } from "./releaseDigestScheduler.js";
import { createReleaseNotesService } from "./releaseNotesService.js";
import { createReportScheduler } from "./reportScheduler.js";
import { createReportService } from "./reportService.js";
import { DraftCanceledError, CategoryRequiredError, createRepository } from "./repository.js";
import { shouldRateLimitRequest } from "./routing.js";
import {
  createTelegramBot,
  draftCanceledMessageText,
  savedSummaryKeyboard,
  sendTelegramMessage,
  updateDraftMessageToCanceled,
  updateDraftMessageToDraftState,
  updateDraftMessageToSaved,
  updateTelegramMessageAfterExpenseDelete
} from "./telegram.js";
import { formatSavedSummary } from "./telegramFormat.js";
import { createVoiceTranscriber } from "./voiceTranscriber.js";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const webRoot = join(root, "apps", "miniapp", "src");
const readJson = createJsonReader({ maxJsonBytes: config.maxJsonBytes });
const serveStatic = createStaticHandler({ webRoot });
const apiSecurity = createApiSecurity({
  telegramBotToken: config.telegramBotToken,
  requireTelegramInitData: config.requireTelegramInitData,
  telegramWebhookSecret: config.telegramWebhookSecret
});

requireRuntimeConfig();
await migrate();

const repository = createRepository(pool, {
  defaultMonthlyBudget: config.defaultMonthlyBudget,
  exchangeRates: createExchangeRateProvider()
});
const adminStatsService = createAdminStatsService({ pool });
const expenseParser = createExpenseParser({
  apiKey: config.openAiApiKey,
  model: config.openAiModel,
  fastPathMode: config.expenseFastPathMode,
  localFirstRolloutPercent: config.expenseParserLocalFirstRolloutPercent,
  localFirstUserIds: config.expenseParserLocalFirstUserIds,
  maxLocalAmount: config.expenseParserMaxLocalAmount,
  parserTextHashSecret: config.parserTextHashSecret
});
const voiceTranscriber = createVoiceTranscriber({
  telegramBotToken: config.telegramBotToken,
  deepgramApiKey: config.deepgramApiKey
});
const adminTelegramIds = parseAdminTelegramIds(config.adminTelegramIds);
if (adminTelegramIds.size === 0) {
  console.warn("[admin] ADMIN_TELEGRAM_IDS is empty; admin commands are disabled");
}
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
  logger: console
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
const rateLimiter = createRateLimiter({
  limit: config.rateLimitMax,
  windowMs: config.rateLimitWindowMs
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
    console.error(error);
    sendJson(res, 500, { error: "internal_error" });
  }
});

server.listen(config.port, () => {
  console.log(`Money Flow API listening on http://localhost:${config.port}`);
});

function startDailyReminderScheduler() {
  if (!config.telegramBotToken || !config.dailyReminderGlobalEnabled) return;
  const run = async () => {
    try {
      await dailyReminderService.runOnce();
    } catch (error) {
      console.error("[daily-reminder] failed", error);
    }
  };
  setTimeout(run, 15_000);
  setInterval(run, Math.max(config.dailyReminderIntervalMs, 60_000));
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (await handleDevRoute({ req, res, url, readJson, repository, createBot, serveStatic })) {
    return;
  }

  if (shouldRateLimitRequest(req, url)) {
    const rate = rateLimiter.check(req.socket.remoteAddress ?? "unknown");
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

  if (req.method === "GET" && url.pathname === "/api/dashboard") {
    const auth = apiSecurity.resolveTelegramUserId(req, url);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const telegramUserId = auth.telegramUserId;
    const timeZone = req.headers["x-user-timezone"];
    if (timeZone) await repository.syncUserTimezone(telegramUserId, timeZone);
    const dashboard = await repository.dashboard(telegramUserId);
    if (!dashboard) return sendJson(res, 404, { error: "user_not_found" });
    return sendJson(res, 200, dashboard);
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

  const plannedMatch = url.pathname.match(/^\/api\/planned-expenses\/(\d+)$/);
  if (plannedMatch && (req.method === "PATCH" || req.method === "DELETE")) {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    let plannedExpense;
    try {
      plannedExpense = req.method === "PATCH"
        ? await repository.updatePlannedExpense(auth.telegramUserId, Number(plannedMatch[1]), body.plannedExpense)
        : await repository.deactivatePlannedExpense(auth.telegramUserId, Number(plannedMatch[1]));
    } catch (error) {
      if (error.code === "reserve_conflicts_with_planned_change") {
        return sendJson(res, 409, { error: error.code });
      }
      throw error;
    }
    if (!plannedExpense) return sendJson(res, 404, { error: "planned_expense_not_found" });
    return sendJson(res, 200, { plannedExpense });
  }

  if (req.method === "PATCH" && url.pathname === "/api/settings/budget") {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const user = await repository.updateMonthlyBudget(auth.telegramUserId, Number(body.monthlyBudgetAmount));
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
        return sendJson(res, 409, { error: error.code });
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
        return sendJson(res, 409, { error: error.code });
      }
      throw error;
    }
    if (!user) return sendJson(res, 404, { error: "user_not_found" });
    return sendJson(res, 200, { user });
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
          baseCurrency: user.base_currency ?? "THB",
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
        const result = await repository.saveDraftAsExpense(draftId, auth.telegramUserId);
        const draft = await repository.getDraftForTelegramUser(draftId, auth.telegramUserId);
        if (draft?.tg_chat_id && draft?.tg_message_id) {
          const total = result.expenses.reduce((sum, expense) => sum + Number(expense.amount_base), 0);
          const text = formatSavedSummary(total, result.dashboardSnapshot, { language, expenses: result.expenses });
          await updateDraftMessageToSaved({ token: config.telegramBotToken, draft, text, replyMarkup: savedSummaryKeyboard(config.miniAppUrl, auth.telegramUserId, language), telegramClient: null })
            .catch((error) => console.error("[server] confirm message update failed", error.message));
        }
        return sendJson(res, 200, { expenses: result.expenses, dashboardSnapshot: result.dashboardSnapshot, alreadySaved: result.alreadySaved });
      } catch (error) {
        if (error instanceof DraftCanceledError) return sendJson(res, 409, { error: "draft_canceled" });
        if (error instanceof CategoryRequiredError) return sendJson(res, 422, { error: "category_required" });
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
    try {
      const health = await repository.health();
      return sendJson(res, 200, { ok: true, ...health });
    } catch (error) {
      console.error("[health] database check failed", error.message);
      return sendJson(res, 503, { ok: false, db: false });
    }
  }

  if (req.method === "GET") {
    return serveStatic(res, url.pathname === "/" ? "/index.html" : url.pathname);
  }

  sendJson(res, 404, { error: "not_found" });
}
