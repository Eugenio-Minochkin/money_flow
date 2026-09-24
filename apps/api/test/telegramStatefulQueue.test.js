import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramBot } from "../src/telegram.js";

const fixedNow = () => new Date("2026-09-23T12:00:00Z");

test("queued Save callback is acknowledged before a slow same-user parse and saves only after the barrier", { timeout: 5000 }, async (t) => {
  const enteredParse = Promise.withResolvers();
  const releaseParse = Promise.withResolvers();
  const callbackAck = Promise.withResolvers();
  t.after(() => releaseParse.resolve());
  const user = {
    id: 1, telegram_user_id: 100, base_currency: "GEL", timezone: "Asia/Tbilisi",
    interface_language: "en", onboarding_step: "completed"
  };
  let saves = 0;
  const calls = [];
  const repository = {
    async upsertTelegramUser() { return user; },
    async getUserByTelegramId() { return user; },
    async getRoutableTelegramInputSession() { return null; },
    async getPendingAccountDeletion() { return null; },
    async recordAppEvent() {},
    async claimTelegramExpenseCapture() { return { state: "claimed", claimVersion: 1 }; },
    async failTelegramExpenseCapture() {},
    async releaseTelegramExpenseCapture() {},
    async confirmDraftWithExplicitAcceptance(draftId, telegramId) {
      assert.equal(draftId, "42");
      assert.equal(telegramId, 100);
      saves++;
      return { expenses: [{ id: 7, amount_base: 80, amount_original: 80, currency_original: "GEL", description: "coffee" }], dashboardSnapshot: null, alreadySaved: false };
    },
    async recordAppEventOnce() {},
    async closeTelegramInputSessionForTarget() { return { outcome: "closed" }; }
  };
  const telegramClient = {
    async answerCallbackQuery(input) {
      calls.push({ method: "answerCallbackQuery", ...input });
      callbackAck.resolve();
      return { ok: true };
    },
    async sendMessage(input) { calls.push({ method: "sendMessage", ...input }); return { ok: true, result: { message_id: 80 } }; },
    async editMessageText(input) { calls.push({ method: "editMessageText", ...input }); return { ok: true, result: { message_id: input.messageId } }; },
    async deleteMessage() { return { ok: true }; }
  };
  const bot = createTelegramBot({
    repository, token: "synthetic", miniAppUrl: "https://example.invalid", telegramClient,
    now: fixedNow, perfLogger: () => {}, awaitQueuedJobs: false,
    telegramJobQueueOptions: { globalConcurrency: 3 },
    expenseParser: { async parse() { enteredParse.resolve(); await releaseParse.promise; throw new Error("synthetic parser failure"); } }
  });
  const a = bot.handleUpdate({ message: { message_id: 101, from: { id: 100 }, chat: { id: 10 }, text: "coffee 80 taxi 120" } });
  await enteredParse.promise;
  const save = bot.handleUpdate({ callback_query: {
    id: "callback-save-behind-parse", data: "confirm:42", from: { id: 100 },
    message: { chat: { id: 10 }, message_id: 55 }
  } });
  let timeout;
  try {
    await Promise.race([callbackAck.promise, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Save callback was not acknowledged while queued")), 500); })]);
    assert.equal(saves, 0, "financial mutation must remain behind the active parse");
    assert.equal(calls.filter((call) => call.method === "answerCallbackQuery").length, 1);
    assert.equal(calls.find((call) => call.method === "answerCallbackQuery").text, undefined, "early ACK is intentionally blank");
    releaseParse.resolve();
    await Promise.all([a, save]);
    assert.equal(saves, 1, "queued callback should save once after the barrier releases");
    assert.equal(calls.filter((call) => call.method === "answerCallbackQuery").length, 1, "late callback handling must not send a duplicate ACK");
  } finally {
    clearTimeout(timeout);
    releaseParse.resolve();
    await Promise.allSettled([a, save]);
  }
});
