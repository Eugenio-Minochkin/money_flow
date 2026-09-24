import test from "node:test";
import assert from "node:assert/strict";
import { createExpenseParser, evaluateLocalFastPath } from "../src/expenseParser.js";
import { createTelegramBot } from "../src/telegram.js";
import { parseExpenseText } from "../../../packages/shared/src/parser.js";

const fixedNow = () => new Date("2026-09-23T12:00:00Z");

test("durable local-safe capture saves and delivers before same-user LLM; webhook and restarted replay do not duplicate it", { timeout: 8000 }, async (t) => {
  const slowText = "coffee 80 taxi 120";
  assert.equal(evaluateLocalFastPath({ text: slowText, localResult: parseExpenseText(slowText) }).localAcceptanceLevel, "local_rejected");
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const bDelivered = Promise.withResolvers();
  t.after(() => release.resolve());
  let paidCalls = 0;
  let parseCalls = 0;
  const paidKeys = [];
  const parser = createExpenseParser({
    apiKey: "synthetic", fastPathMode: "enabled", localFirstRolloutPercent: 100,
    parserTextHashSecret: "synthetic", now: fixedNow,
    consumeLlmUsage: async ({ requestKey }) => { paidCalls++; paidKeys.push(requestKey); },
    fetchImpl: async () => { entered.resolve(); await release.promise; throw new Error("synthetic LLM failure"); }
  });
  const expenseParser = { model: parser.model, parse: (...args) => { parseCalls++; return parser.parse(...args); } };
  const user = { id: 1, telegram_user_id: 100, base_currency: "GEL", timezone: "Asia/Tbilisi", interface_language: "en", onboarding_step: "completed" };
  const captures = new Map();
  const drafts = new Map();
  const expenses = new Map();
  const refs = new Map();
  const events = [];
  let draftId = 0;
  let messageId = 500;
  const repository = {
    async upsertTelegramUser() { return user; },
    async getUserByTelegramId() { return user; },
    async getRoutableTelegramInputSession() { return null; },
    async getPendingAccountDeletion() { return null; },
    async recordAppEvent(_id, name, metadata) { events.push({ name, metadata }); },
    async claimTelegramExpenseCapture(_userId, _chatId, id) {
      const old = captures.get(id);
      if (old) return { ...old };
      const claim = { state: "processing", claimVersion: 1, captureId: id, attemptNumber: 1 };
      captures.set(id, claim);
      return { ...claim, state: "claimed" };
    },
    async completeTelegramExpenseCapture({ messageId: id, claimVersion, items }) {
      assert.equal(claimVersion, captures.get(id).claimVersion);
      const draft = { id: ++draftId, status: "pending", items };
      drafts.set(draft.id, draft);
      captures.set(id, { state: "completed", draft });
      return { draft };
    },
    async releaseTelegramExpenseCapture(_u, _c, id) { captures.set(id, { state: "failed" }); },
    async failTelegramExpenseCapture(_u, _c, id) { if (captures.get(id)?.state === "processing") captures.set(id, { state: "failed" }); },
    async getDraftForTelegramUser(id) { return drafts.get(id); },
    async listClosedReserveMonthsForTelegramUser() { return []; },
    async saveDraftAsExpense(id, _telegramId, options = {}) {
      const draft = drafts.get(id);
      if (expenses.has(id)) return { expenses: [expenses.get(id)], alreadySaved: true, dashboardSnapshot: null };
      await options.beforeSave?.({ ...draft, timezone: user.timezone, base_currency: user.base_currency });
      const item = draft.items[0];
      const expense = { id, draft_id: id, ...item, amount_base: item.amount, amount_original: item.amount, currency_original: item.currency };
      expenses.set(id, expense);
      draft.status = "confirmed";
      return { expenses: [expense], alreadySaved: false, dashboardSnapshot: null };
    },
    async setDraftMessageRef(id, _telegramId, chatId, ref) { Object.assign(drafts.get(id), { tg_chat_id: chatId, tg_message_id: ref }); }
  };
  const telegramClient = {
    async sendMessage(input) { const id = messageId++; refs.set(id, input.replyParameters?.message_id); return { ok: true, result: { message_id: id } }; },
    async editMessageText(input) {
      if (refs.get(input.messageId) === 102 && expenses.size === 1) bDelivered.resolve();
      return { ok: true, result: { message_id: input.messageId } };
    },
    async deleteMessage() { return { ok: true }; }
  };
  const options = { repository, token: "synthetic", miniAppUrl: "https://example.invalid", expenseParser, telegramClient, now: fixedNow, perfLogger: () => {}, telegramJobQueueOptions: { globalConcurrency: 3 } };
  const bot = createTelegramBot(options);
  const update = (id, text) => ({ message: { message_id: id, from: { id: 100 }, chat: { id: 10 }, text } });
  const a = bot.handleUpdate(update(101, slowText));
  await entered.promise;
  await bot.handleUpdate(update(101, slowText));
  const b = bot.handleUpdate(update(102, "кофейня 15 лари"));
  let timeout;
  try {
    await Promise.race([bDelivered.promise, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("B did not save and deliver before A release")), 750); })]);
    await b;
    assert.equal(expenses.size, 1);
    await bot.handleUpdate(update(102, "кофейня 15 лари"));
    await createTelegramBot(options).handleUpdate(update(102, "кофейня 15 лари"));
    assert.equal(expenses.size, 1);
    assert.equal(drafts.size, 1);
    assert.equal(parseCalls, 2);
    assert.equal(paidCalls, 1);
    assert.deepEqual(paidKeys, ["telegram:1:10:101"]);
  } finally {
    clearTimeout(timeout);
    release.resolve();
    await Promise.all([a, b]);
  }
  assert.equal(captures.get(101).state, "failed");
  assert.equal(captures.get(102).state, "completed");
  const completed = events.find((event) => event.name === "message_processing_completed" && event.metadata.result === "expense_saved").metadata;
  for (const field of ["parseWaitMs", "mutationWaitMs", "telegramResponseMs", "endToEndTotalMs", "admissionMs", "captureEndToEndMs"]) assert.ok(Number.isFinite(completed[field]) && completed[field] >= 0, field);
  t.diagnostic(JSON.stringify({ parseWaitMs: completed.parseWaitMs, mutationWaitMs: completed.mutationWaitMs, telegramResponseMs: completed.telegramResponseMs, endToEndTotalMs: completed.endToEndTotalMs, admissionMs: completed.admissionMs, captureEndToEndMs: completed.captureEndToEndMs, terminalDeliveryOutcome: completed.terminalDeliveryOutcome }));
});

test("repeated feedback barriers neither nest queue jobs nor leak admission reservations", { timeout: 3000 }, async () => {
  const user = { id: 2, telegram_user_id: 200, interface_language: "en", onboarding_step: "completed", base_currency: "GEL", timezone: "Asia/Tbilisi" };
  let feedbacks = 0;
  let parses = 0;
  const bot = createTelegramBot({
    token: "synthetic", miniAppUrl: "https://example.invalid", now: fixedNow, perfLogger: () => {},
    telegramJobQueueOptions: { globalConcurrency: 1, userQueueLimit: 1, globalQueueLimit: 1, jobTimeoutMs: 500 },
    repository: {
      async upsertTelegramUser() { return user; },
      async getUserByTelegramId() { return user; },
      async getRoutableTelegramInputSession() { return null; },
      async getPendingAccountDeletion() { return null; },
      async createFeedback() { feedbacks++; return { id: feedbacks }; },
      async recordAppEvent() {}
    },
    expenseParser: { async parse() { parses++; return { expenses: [] }; } },
    telegramClient: { async sendMessage() { return { ok: true, result: { message_id: 600 } }; } }
  });
  for (let i = 0; i < 3; i++) {
    await bot.handleUpdate({ message: { message_id: i * 2 + 1, from: { id: 200 }, chat: { id: 20 }, text: "/feedback" } });
    await bot.handleUpdate({ message: { message_id: i * 2 + 2, from: { id: 200 }, chat: { id: 20 }, text: "the synthetic feedback" } });
  }
  assert.equal(feedbacks, 3);
  assert.equal(parses, 0);
});
