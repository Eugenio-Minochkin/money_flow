import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createTelegramBot } from "../src/telegram.js";

const texts = ["Ужин 40 лари", "Продукты в магазине 12,64 лари", "кофейня 15 лари"];
const now = () => new Date("2026-09-24T12:00:00Z");

function harness({ parse, upsert, finish, jobTimeoutMs = 90000 } = {}) {
  const user = { id: 237, telegram_user_id: 23700, base_currency: "GEL", timezone: "Asia/Tbilisi", interface_language: "ru", onboarding_step: "completed" };
  const captures = new Map(), drafts = new Map(), saved = new Map(), refs = new Map();
  const effects = [], ready = [], entered = [], claims = [], failedParses = [];
  let messageId = 900;
  const terminal = (input, source) => {
    if (!/Записал|Не получилось/.test(input.text)) return;
    source ??= failedParses.find(id => !effects.includes(`terminal${id}`));
    assert.ok(source, "terminal result belongs to a known source or failed parser");
    effects.push(`terminal${source}`);
  };
  const repository = {
    async upsertTelegramUser() { await upsert?.(); return user; },
    async getUserByTelegramId() { return user; },
    async getRoutableTelegramInputSession() { return null; },
    async getPendingAccountDeletion() { return null; },
    async recordAppEvent() {},
    async claimTelegramExpenseCapture(_user, _chat, id) {
      if (captures.has(id)) return { ...captures.get(id), deliveryClaimed: false };
      claims.push(id);
      const capture = { state: "processing", claimVersion: 1, captureId: id, attemptNumber: 1, deliveryPending: true };
      captures.set(id, capture);
      return { ...capture, state: "claimed", deliveryClaimed: true };
    },
    async listPrecedingTelegramExpenseCaptures(_user, _chat, id) {
      return [...captures].filter(([key, value]) => key < id && value.deliveryPending).map(([key]) => ({ chat_id: 23700, message_id: key }));
    },
    async completeTelegramExpenseCapture({ messageId: id, items }) {
      const draft = { id, status: "pending", items };
      drafts.set(id, draft); Object.assign(captures.get(id), { state: "completed", draft }); return { draft };
    },
    async releaseTelegramExpenseCapture(_u, _c, id) { captures.get(id).state = "failed"; },
    async failTelegramExpenseCapture(_u, _c, id) { if (captures.get(id)?.state === "processing") captures.get(id).state = "failed"; },
    async finishTelegramExpenseCaptureDelivery(_u, _c, id) {
      if (finish && !await finish(id)) return false;
      captures.get(id).deliveryPending = false; return true;
    },
    async deferTelegramExpenseCapture() {},
    async getDraftForTelegramUser(id) { return drafts.get(id); },
    async listClosedReserveMonthsForTelegramUser() { return []; },
    async saveDraftAsExpense(id, _user, options) {
      const draft = drafts.get(id); await options.beforeSave(draft);
      const item = draft.items[0];
      const expense = { ...item, id, amount_base: item.amount, amount_original: item.amount, currency_original: item.currency };
      const alreadySaved = saved.has(id); saved.set(id, expense); draft.status = "confirmed";
      effects.push(`save${id}`); return { expenses: [expense], alreadySaved, dashboardSnapshot: null };
    },
    async setDraftMessageRef() {}
  };
  const bot = createTelegramBot({ repository, token: "synthetic", miniAppUrl: "https://example.invalid", now, perfLogger: () => {}, telegramJobQueueOptions: { globalConcurrency: 3, jobTimeoutMs },
    expenseParser: { async parse(text, options) {
      const id = texts.indexOf(text) + 101; entered.push(id);
      try { await parse?.(id, options.signal); } catch (error) { failedParses.push(id); throw error; }
      ready.push(id);
      return { expenses: [{ amount: id, currency: "GEL", description: text, category_slug: "food_cafe", category_source: "parser", needs_review: false, spent_at: now().toISOString(), budget_impact: "regular", tags: [] }] };
    } },
    telegramClient: {
      async sendMessage(input) { const id = ++messageId; refs.set(id, input.replyParameters?.message_id); terminal(input, input.replyParameters?.message_id); return { ok: true, result: { message_id: id } }; },
      async editMessageText(input) { terminal(input, refs.get(input.messageId)); return { ok: true, result: { message_id: input.messageId } }; },
      async deleteMessage() { return { ok: true }; }
    }
  });
  return { effects, ready, entered, claims, saved, captures, send: id => bot.handleUpdate({ message: { message_id: id, chat: { id: 23700 }, from: { id: 23700 }, text: texts[id - 101] } }) };
}

async function until(predicate) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await nextTurn(); }
  assert.fail("expected asynchronous checkpoint was not reached");
}

test("first processing, second ready: an injected 20-second parse cannot be overtaken by a saved receipt", { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: now().getTime() });
  const h = harness({ parse: id => id === 101 ? new Promise(resolve => setTimeout(resolve, 20000)) : undefined });
  const a = h.send(101); await until(() => h.entered.includes(101));
  const b = h.send(102); await until(() => h.ready.includes(102));
  assert.deepEqual(h.effects, []);
  t.mock.timers.tick(19999); await nextTurn(); assert.deepEqual(h.effects, []);
  t.mock.timers.tick(1); await Promise.all([a, b]);
  assert.deepEqual(h.effects, ["save101", "terminal101", "save102", "terminal102"]);
});

test("three captures save and deliver A B C despite B parsing first", { timeout: 5000 }, async () => {
  const gate = Promise.withResolvers();
  const h = harness({ parse: id => id === 101 ? gate.promise : undefined });
  const a = h.send(101); await until(() => h.entered.includes(101));
  const b = h.send(102); const c = h.send(103);
  try { await until(() => h.ready.includes(102)); assert.deepEqual(h.effects, []); }
  finally { gate.resolve(); await Promise.all([a, b, c]); }
  assert.deepEqual(h.effects, ["save101", "terminal101", "save102", "terminal102", "save103", "terminal103"]);
});

test("a timed out first parser delivers its error before a ready successor saves", { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: now().getTime() });
  const h = harness({ jobTimeoutMs: 100, parse: (id, signal) => id === 101 ? new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) : undefined });
  const a = h.send(101); await until(() => h.entered.includes(101));
  const b = h.send(102); await until(() => h.ready.includes(102));
  t.mock.timers.tick(100);
  await Promise.all([a, b]);
  assert.deepEqual(h.effects, ["terminal101", "save102", "terminal102"]);
});

test("slow first user-context lookup cannot reverse durable claim or save order", { timeout: 5000 }, async () => {
  const gate = Promise.withResolvers(); let calls = 0;
  const h = harness({ upsert: () => ++calls === 1 ? gate.promise : undefined });
  const a = h.send(101); const b = h.send(102);
  await nextTurn(); assert.deepEqual(h.claims, []);
  gate.resolve(); await Promise.all([a, b]);
  assert.deepEqual(h.claims, [101, 102]);
  assert.deepEqual(h.effects, ["save101", "terminal101", "save102", "terminal102"]);
});

test("a failed durable delivery finalization prevents the successor from committing", { timeout: 5000 }, async () => {
  const gate = Promise.withResolvers();
  const h = harness({ parse: id => id === 101 ? gate.promise : undefined, finish: id => id !== 101 });
  const a = h.send(101); await until(() => h.entered.includes(101));
  const b = h.send(102); await until(() => h.ready.includes(102));
  gate.resolve(); await Promise.all([a, b]);
  assert.equal(h.saved.has(101), true); assert.equal(h.saved.has(102), false);
  assert.equal(h.captures.get(101).deliveryPending, true);
  assert.equal(h.captures.get(102).state, "processing", "deferred B remains recoverable, not permanently failed");
});
