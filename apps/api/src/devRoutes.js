import { DEMO_TELEGRAM_USER_ID, processDevTelegramUpdate } from "./devTelegram.js";
import { isDevMode } from "./devSafety.js";

export async function handleDevRoute({ req, res, url, readJson, repository, createBot, serveStatic }) {
  const isDevPath = url.pathname === "/dev" || url.pathname.startsWith("/dev/");
  if (!isDevPath) return false;
  if (!isDevMode()) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not_found" }));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/dev") {
    await serveStatic(res, "/dev.html");
    return true;
  }

  if (req.method === "GET" && url.pathname === "/dev/state") {
    const state = await devState(repository, Number(url.searchParams.get("telegramUserId") ?? DEMO_TELEGRAM_USER_ID));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(state));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/dev/telegram/update") {
    const payload = await readJson(req);
    const result = await processDevTelegramUpdate({
      createBot,
      payload: { telegramUserId: DEMO_TELEGRAM_USER_ID, ...payload }
    });
    const state = await devState(repository, Number(payload.telegramUserId ?? DEMO_TELEGRAM_USER_ID));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ...result, state }));
    return true;
  }

  return false;
}

async function devState(repository, telegramUserId) {
  const [dashboard, recentExpenses, pendingDrafts, inboxDrafts, plannedExpenses] = await Promise.all([
    repository.dashboard(telegramUserId),
    repository.listExpensesForTelegramUser(telegramUserId, { period: "month" }),
    repository.listDraftsForTelegramUser(telegramUserId, { status: "pending" }),
    repository.listDraftsForTelegramUser(telegramUserId, { status: "inbox" }),
    repository.listPlannedExpensesForTelegramUser(telegramUserId)
  ]);
  return {
    telegramUserId,
    dashboard,
    recentExpenses: recentExpenses.slice(0, 20),
    drafts: [...pendingDrafts, ...inboxDrafts],
    plannedExpenses
  };
}
