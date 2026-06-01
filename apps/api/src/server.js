import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config, requireRuntimeConfig } from "./config.js";
import { migrate, pool } from "./db.js";
import { createExpenseParser } from "./expenseParser.js";
import { createRepository } from "./repository.js";
import { createTelegramBot } from "./telegram.js";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const webRoot = join(root, "apps", "miniapp", "src");

requireRuntimeConfig();
await migrate();

const repository = createRepository(pool, { defaultMonthlyBudget: config.defaultMonthlyBudget });
const expenseParser = createExpenseParser({
  apiKey: config.openAiApiKey,
  model: config.openAiModel
});
const bot = createTelegramBot({
  repository,
  expenseParser,
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
