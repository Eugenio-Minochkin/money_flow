import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config, requireRuntimeConfig } from "./config.js";
import { migrate, pool } from "./db.js";
import { createExpenseParser } from "./expenseParser.js";
import { createRepository } from "./repository.js";
import { createTelegramBot } from "./telegram.js";
import { createVoiceTranscriber } from "./voiceTranscriber.js";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const webRoot = join(root, "apps", "miniapp", "src");

requireRuntimeConfig();
await migrate();

const repository = createRepository(pool, { defaultMonthlyBudget: config.defaultMonthlyBudget });
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

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "internal_error" });
  }
});

server.listen(config.port, () => {
  console.log(`Money Flow API listening on http://localhost:${config.port}`);
});

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "POST" && url.pathname === "/telegram/webhook") {
    const update = await readJson(req);
    await bot.handleUpdate(update);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/dashboard") {
    const telegramUserId = Number(url.searchParams.get("telegramUserId"));
    if (!telegramUserId) return sendJson(res, 400, { error: "telegramUserId_required" });
    const dashboard = await repository.dashboard(telegramUserId);
    if (!dashboard) return sendJson(res, 404, { error: "user_not_found" });
    return sendJson(res, 200, dashboard);
  }

  if (req.method === "GET" && url.pathname === "/api/expenses") {
    const telegramUserId = Number(url.searchParams.get("telegramUserId"));
    if (!telegramUserId) return sendJson(res, 400, { error: "telegramUserId_required" });
    const expenses = await repository.listExpensesForTelegramUser(telegramUserId, {
      period: url.searchParams.get("period") ?? "month",
      search: url.searchParams.get("search") ?? ""
    });
    return sendJson(res, 200, { expenses });
  }

  if (req.method === "GET" && url.pathname === "/api/planned-expenses") {
    const telegramUserId = Number(url.searchParams.get("telegramUserId"));
    if (!telegramUserId) return sendJson(res, 400, { error: "telegramUserId_required" });
    const plannedExpenses = await repository.listPlannedExpensesForTelegramUser(telegramUserId);
    return sendJson(res, 200, { plannedExpenses });
  }

  if (req.method === "POST" && url.pathname === "/api/planned-expenses") {
    const body = await readJson(req);
    if (!body.telegramUserId) return sendJson(res, 400, { error: "telegramUserId_required" });
    const plannedExpense = await repository.createPlannedExpense(Number(body.telegramUserId), body.plannedExpense);
    if (!plannedExpense) return sendJson(res, 404, { error: "user_not_found" });
    return sendJson(res, 201, { plannedExpense });
  }

  const plannedMatch = url.pathname.match(/^\/api\/planned-expenses\/(\d+)$/);
  if (plannedMatch && (req.method === "PATCH" || req.method === "DELETE")) {
    const body = await readJson(req);
    if (!body.telegramUserId) return sendJson(res, 400, { error: "telegramUserId_required" });
    const plannedExpense = req.method === "PATCH"
      ? await repository.updatePlannedExpense(Number(body.telegramUserId), Number(plannedMatch[1]), body.plannedExpense)
      : await repository.deactivatePlannedExpense(Number(body.telegramUserId), Number(plannedMatch[1]));
    if (!plannedExpense) return sendJson(res, 404, { error: "planned_expense_not_found" });
    return sendJson(res, 200, { plannedExpense });
  }

  if (req.method === "PATCH" && url.pathname === "/api/settings/budget") {
    const body = await readJson(req);
    if (!body.telegramUserId) return sendJson(res, 400, { error: "telegramUserId_required" });
    const user = await repository.updateMonthlyBudget(Number(body.telegramUserId), Number(body.monthlyBudgetAmount));
    if (!user) return sendJson(res, 404, { error: "user_not_found" });
    return sendJson(res, 200, { user });
  }

  const draftMatch = url.pathname.match(/^\/api\/drafts\/(\d+)(\/confirm)?$/);
  if (draftMatch) {
    const draftId = Number(draftMatch[1]);
    if (req.method === "GET" && !draftMatch[2]) {
      const telegramUserId = Number(url.searchParams.get("telegramUserId"));
      if (!telegramUserId) return sendJson(res, 400, { error: "telegramUserId_required" });
      const draft = await repository.getDraftForTelegramUser(draftId, telegramUserId);
      if (!draft) return sendJson(res, 404, { error: "draft_not_found" });
      return sendJson(res, 200, { draft });
    }

    if (req.method === "PATCH" && !draftMatch[2]) {
      const body = await readJson(req);
      if (!body.telegramUserId) return sendJson(res, 400, { error: "telegramUserId_required" });
      const draft = await repository.updateDraftItems(draftId, Number(body.telegramUserId), body.items ?? []);
      if (!draft) return sendJson(res, 404, { error: "draft_not_found" });
      return sendJson(res, 200, { draft });
    }

    if (req.method === "POST" && draftMatch[2]) {
      const body = await readJson(req);
      if (!body.telegramUserId) return sendJson(res, 400, { error: "telegramUserId_required" });
      const expenses = await repository.confirmDraft(draftId, Number(body.telegramUserId));
      return sendJson(res, 200, { expenses });
    }
  }

  const expenseMatch = url.pathname.match(/^\/api\/expenses\/(\d+)$/);
  if (expenseMatch && (req.method === "PATCH" || req.method === "DELETE")) {
    const body = await readJson(req);
    if (!body.telegramUserId) return sendJson(res, 400, { error: "telegramUserId_required" });
    const expense = req.method === "PATCH"
      ? await repository.updateExpenseForTelegramUser(Number(expenseMatch[1]), Number(body.telegramUserId), body.expense)
      : await repository.deleteExpenseForTelegramUser(Number(expenseMatch[1]), Number(body.telegramUserId));
    if (!expense) return sendJson(res, 404, { error: "expense_not_found" });
    return sendJson(res, 200, { expense });
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET") {
    return serveStatic(res, url.pathname === "/" ? "/index.html" : url.pathname);
  }

  sendJson(res, 404, { error: "not_found" });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function serveStatic(res, pathname) {
  const safePath = pathname.replace(/^\/+/, "");
  const filePath = join(webRoot, safePath);
  if (!filePath.startsWith(webRoot)) return sendJson(res, 403, { error: "forbidden" });
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "content-type": contentType(filePath) });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "not_found" });
  }
}

function contentType(filePath) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8"
  }[extname(filePath)] ?? "application/octet-stream";
}
