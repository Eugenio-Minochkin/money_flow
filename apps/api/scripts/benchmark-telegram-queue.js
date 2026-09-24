import { performance } from "node:perf_hooks";

import { createExpenseParser } from "../src/expenseParser.js";
import { createTelegramBot } from "../src/telegram.js";

const delayMs = readDelay(process.argv.slice(2));
const firstText = "coffee 80 taxi 120";
const secondText = "кофейня 15 лари";
const sourceMessageIds = new Map([[101, "a"], [102, "b"]]);
const loaderOwners = new Map();
const timings = { aHttpAt: null, aFailedAt: null, bDispatchAt: null, bParseStartedAt: null, bParseEndedAt: null, bMutationAt: null, bDeliveryStartedAt: null, bDeliveredAt: null };
let nextMessageId = 500;
let resolveAHttp;
let resolveAFailed;
let resolveBDelivered;
let resolveATerminal;
const originalConsoleError = console.error;
const aHttpEntered = new Promise((resolve) => { resolveAHttp = resolve; });
const aFailed = new Promise((resolve) => { resolveAFailed = resolve; });
const bDelivered = new Promise((resolve) => { resolveBDelivered = resolve; });
const aTerminal = new Promise((resolve) => { resolveATerminal = resolve; });

const realParser = createExpenseParser({
  apiKey: "synthetic-benchmark-key",
  fastPathMode: "enabled",
  localFirstRolloutPercent: 100,
  parserTextHashSecret: "synthetic-benchmark-secret",
  llmTimeoutMs: delayMs + 30_000,
  now: () => new Date("2026-09-23T12:00:00Z"),
  fetchImpl: async () => {
    timings.aHttpAt = performance.now();
    resolveAHttp();
    await wait(delayMs);
    timings.aFailedAt = performance.now();
    resolveAFailed();
    throw new Error("synthetic controlled parser failure");
  }
});
const expenseParser = {
  model: realParser.model,
  async parse(text, options) {
    if (text === secondText) timings.bParseStartedAt = performance.now();
    try {
      const result = await realParser.parse(text, options);
      if (text === secondText) timings.bParseEndedAt = performance.now();
      return result;
    } catch (error) {
      if (text === firstText) {
        timings.aFailedAt ??= performance.now();
        resolveAFailed();
      }
      throw error;
    }
  }
};

const repository = {
  user: { id: 9001, telegram_user_id: 9001, interface_language: "ru", onboarding_step: "completed", base_currency: "GEL", timezone: "Asia/Tbilisi" },
  drafts: [],
  captures: new Map(),
  expenses: [],
  saveCalls: 0,
  async getUserByTelegramId() { return this.user; },
  async upsertTelegramUser() { return this.user; },
  async recordAppEvent() {},
  async recordAppEventOnce() { return { recorded: true }; },
  async claimTelegramExpenseCapture(userId, chatId, messageId) {
    const key = captureKey(userId, chatId, messageId);
    const existing = this.captures.get(key);
    if (existing?.state === "completed") return { ...existing, draft: existing.draft };
    if (existing) return { ...existing, state: "processing" };
    const claim = { state: "claimed", claimVersion: 1 };
    this.captures.set(key, claim);
    return claim;
  },
  async completeTelegramExpenseCapture({ userId, chatId, messageId, sourceText, items }) {
    const key = captureKey(userId, chatId, messageId);
    if (items.some((item) => item.amount === 15 && item.currency === "GEL")) timings.bMutationAt = performance.now();
    const draft = { id: this.drafts.length + 1, items, sourceText };
    this.drafts.push(draft);
    this.captures.set(key, { state: "completed", draft });
    return { draft };
  },
  async releaseTelegramExpenseCapture(userId, chatId, messageId) {
    this.captures.delete(captureKey(userId, chatId, messageId));
  },
  async failTelegramExpenseCapture(userId, chatId, messageId) {
    this.captures.set(captureKey(userId, chatId, messageId), { state: "failed" });
  },
  async listClosedReserveMonthsForTelegramUser() { return []; },
  async saveDraftAsExpense(draftId, _telegramUserId) {
    this.saveCalls += 1;
    const draft = this.drafts.find((item) => item.id === draftId);
    const expenses = draft.items.map((item) => ({ id: this.expenses.length + 1, ...item, amount_base: item.amount }));
    this.expenses.push(...expenses);
    return { expenses, alreadySaved: false, dashboardSnapshot: { today: 0, week: 0, month: 0, monthlyBudget: null, remaining: null } };
  },
  async createDraft(_userId, _sourceText, items) {
    const draft = { id: this.drafts.length + 1, items };
    this.drafts.push(draft);
    return draft;
  },
  async getDraftForTelegramUser(draftId) { return this.drafts.find((draft) => draft.id === draftId) ?? null; },
  async setDraftMessageRef() {}
};

const telegramClient = {
  async sendMessage({ replyParameters }) {
    const messageId = nextMessageId++;
    const owner = sourceMessageIds.get(replyParameters?.message_id)
      ?? (timings.bDispatchAt != null && timings.bParseStartedAt == null ? "b" : null);
    if (owner) loaderOwners.set(messageId, owner);
    return { ok: true, result: { message_id: messageId } };
  },
  async editMessageText({ messageId }) {
    const owner = loaderOwners.get(messageId);
    if (owner === "b" && repository.expenses.length === 1 && timings.bDeliveredAt == null) {
      timings.bDeliveryStartedAt = performance.now();
      timings.bDeliveredAt = performance.now();
      resolveBDelivered();
    }
    if (owner === "a") resolveATerminal();
    return { ok: true };
  },
  async deleteMessage() { return { ok: true }; }
};

const bot = createTelegramBot({
  repository,
  token: "synthetic-benchmark-token",
  miniAppUrl: "http://localhost:3000",
  expenseParser,
  telegramClient,
  perfLogger: () => {},
  adminAlertService: { async notify() {} },
  now: () => new Date("2026-09-23T12:00:00Z"),
  awaitQueuedJobs: false,
  telegramJobQueueOptions: { globalConcurrency: 2, jobTimeoutMs: delayMs + 60_000 }
});

console.error = (...args) => {
  if (args[0] !== "[telegram] expense processing failed") originalConsoleError(...args);
};
try {
  await bot.handleUpdate(messageUpdate(firstText, 101));
  await aHttpEntered;
  timings.bDispatchAt = performance.now();
  await bot.handleUpdate(messageUpdate(secondText, 102));
  await Promise.race([bDelivered, wait(1_000).then(() => { throw new Error("second expense was not delivered within 1 second"); })]);
  await aFailed;
  await aTerminal;

  const round = (value) => Math.round(value * 10) / 10;
  const result = {
    delayMs,
    aControlledFailureAfterHttpMs: round(timings.aFailedAt - timings.aHttpAt),
    bParseWaitMs: round(timings.bParseStartedAt - timings.bDispatchAt),
    bMutationWaitMs: round(timings.bMutationAt - timings.bParseEndedAt),
    bDeliveryMs: round(timings.bDeliveredAt - timings.bDeliveryStartedAt),
    bEndToEndMs: round(timings.bDeliveredAt - timings.bDispatchAt),
    bExpensePersistedExactlyOnce: repository.expenses.length === 1 && repository.saveCalls === 1,
    bDeliveredBeforeARelease: timings.bDeliveredAt < timings.aFailedAt
  };
  console.log(JSON.stringify(result));
  if (!result.bExpensePersistedExactlyOnce || !result.bDeliveredBeforeARelease || result.bEndToEndMs >= 1_000 || result.aControlledFailureAfterHttpMs < delayMs) process.exitCode = 1;
} finally {
  console.error = originalConsoleError;
}

function messageUpdate(text, messageId) {
  return { message: { message_id: messageId, chat: { id: 9001 }, from: { id: 9001, first_name: "Synthetic" }, text } };
}

function captureKey(userId, chatId, messageId) {
  return `${userId}:${chatId}:${messageId}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readDelay(args) {
  const index = args.indexOf("--delay-ms");
  const value = index >= 0 ? Number(args[index + 1]) : 20_000;
  if (!Number.isSafeInteger(value) || value < 100) throw new Error("Usage: node benchmark-telegram-queue.js [--delay-ms 20000]");
  return value;
}
