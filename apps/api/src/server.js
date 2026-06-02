import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config, requireRuntimeConfig } from "./config.js";
import { createApiSecurity } from "./apiSecurity.js";
import { migrate, pool } from "./db.js";
import { createExchangeRateProvider } from "./exchangeRates.js";
import { createExpenseParser } from "./expenseParser.js";
import { createJsonReader, createStaticHandler, sendJson } from "./http.js";
import { createRateLimiter } from "./rateLimit.js";
import { createRepository } from "./repository.js";
import { createTelegramBot, sendWeeklyReports, shouldSendWeeklyReport } from "./telegram.js";
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
const expenseParser = createExpenseParser({
  apiKey: config.openAiApiKey,
  model: config.openAiModel
});
const voiceTranscriber = createVoiceTranscriber({
  telegramBotToken: config.telegramBotToken,
  deepgramApiKey: config.deepgramApiKey
});
const bot = createTelegramBot({
  repository,
  expenseParser,
  voiceTranscriber,
  token: config.telegramBotToken,
  miniAppUrl: config.miniAppUrl
});
const rateLimiter = createRateLimiter({
  limit: config.rateLimitMax,
  windowMs: config.rateLimitWindowMs
});
startWeeklyReportScheduler();

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

function startWeeklyReportScheduler() {
  if (!config.telegramBotToken) return;
  const run = async () => {
    const now = new Date();
    if (!shouldSendWeeklyReport(now)) return;
    try {
      await sendWeeklyReports({ repository, token: config.telegramBotToken, miniAppUrl: config.miniAppUrl, now });
    } catch (error) {
      console.error("[weekly-report] failed", error);
    }
  };
  setTimeout(run, 10_000);
  setInterval(run, 60 * 60_000);
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const rate = rateLimiter.check(req.socket.remoteAddress ?? "unknown");
  if (!rate.allowed) {
    res.setHeader("retry-after", String(rate.retryAfterSeconds));
    return sendJson(res, 429, { error: "rate_limited", retryAfterSeconds: rate.retryAfterSeconds });
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
    const dashboard = await repository.dashboard(telegramUserId);
    if (!dashboard) return sendJson(res, 404, { error: "user_not_found" });
    return sendJson(res, 200, dashboard);
  }

  if (req.method === "GET" && url.pathname === "/api/expenses") {
    const auth = apiSecurity.resolveTelegramUserId(req, url);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const expenses = await repository.listExpensesForTelegramUser(auth.telegramUserId, {
      period: url.searchParams.get("period") ?? "month",
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
    return sendJson(res, 200, { plannedExpenses });
  }

  if (req.method === "POST" && url.pathname === "/api/planned-expenses") {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const plannedExpense = await repository.createPlannedExpense(auth.telegramUserId, body.plannedExpense);
    if (!plannedExpense) return sendJson(res, 404, { error: "user_not_found" });
    return sendJson(res, 201, { plannedExpense });
  }

  const plannedMatch = url.pathname.match(/^\/api\/planned-expenses\/(\d+)$/);
  if (plannedMatch && (req.method === "PATCH" || req.method === "DELETE")) {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const plannedExpense = req.method === "PATCH"
      ? await repository.updatePlannedExpense(auth.telegramUserId, Number(plannedMatch[1]), body.plannedExpense)
      : await repository.deactivatePlannedExpense(auth.telegramUserId, Number(plannedMatch[1]));
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

  if (req.method === "PATCH" && url.pathname === "/api/settings") {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const user = await repository.updateUserSettings(auth.telegramUserId, body.settings ?? {});
    if (!user) return sendJson(res, 404, { error: "user_not_found" });
    return sendJson(res, 200, { user });
  }

  const plannedPayMatch = url.pathname.match(/^\/api\/planned-expenses\/(\d+)\/pay$/);
  if (plannedPayMatch && req.method === "POST") {
    const body = await readJson(req);
    const auth = apiSecurity.resolveTelegramUserId(req, url, body);
    if (auth.error) return sendJson(res, 400, { error: auth.error });
    const expense = await repository.payPlannedExpenseForTelegramUser(
      Number(plannedPayMatch[1]),
      auth.telegramUserId,
      body.paidAt ? new Date(body.paidAt) : new Date()
    );
    return sendJson(res, 200, { expense });
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
      const draft = await repository.updateDraftItems(draftId, auth.telegramUserId, body.items ?? []);
      if (!draft) return sendJson(res, 404, { error: "draft_not_found" });
      return sendJson(res, 200, { draft });
    }

    if (req.method === "DELETE" && !draftMatch[2]) {
      const body = await readJson(req);
      const auth = apiSecurity.resolveTelegramUserId(req, url, body);
      if (auth.error) return sendJson(res, 400, { error: auth.error });
      await repository.cancelDraft(draftId, auth.telegramUserId);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && draftMatch[2]) {
      const body = await readJson(req);
      const auth = apiSecurity.resolveTelegramUserId(req, url, body);
      if (auth.error) return sendJson(res, 400, { error: auth.error });
      const expenses = await repository.confirmDraft(draftId, auth.telegramUserId);
      return sendJson(res, 200, { expenses });
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
