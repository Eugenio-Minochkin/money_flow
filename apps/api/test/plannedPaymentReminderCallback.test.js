import test from "node:test";
import assert from "node:assert/strict";

import { handleCallback } from "../src/telegram.js";

test("planned reminder paid callback acks first and renders the shared saved summary with a fresh dashboard", async () => {
  const calls = [];
  const repository = fakeRepository();
  await handleCallback({
    update: callbackUpdate("ppr:p:42:20260727"),
    repository,
    token: "token",
    miniAppUrl: "http://localhost:3000",
    telegramClient: client(calls),
    trace: trace(),
    now: () => new Date("2026-07-27T14:05:00Z")
  });

  assert.equal(calls[0].method, "answerCallbackQuery");
  assert.match(calls[0].text, /Saving/);
  assert.deepEqual(repository.payCalls, [{
    plannedExpenseId: 42,
    telegramUserId: 100,
    occurrenceDate: "2026-07-27"
  }]);
  assert.equal(repository.dashboardCalls, 1);
  const edit = calls.find((call) => call.method === "editMessageText");
  assert.match(edit.text, /Saved:/);
  assert.match(edit.text, /Planned today/);
  assert.deepEqual(edit.replyMarkup.inline_keyboard.map((row) => row[0].text), ["📱 Open Mini App"]);
  assert.doesNotMatch(JSON.stringify(edit.replyMarkup), /Edit|Delete/);
});

test("planned reminder paid callback keeps the committed expense when dashboard summary fails", async () => {
  const calls = [];
  const repository = fakeRepository();
  repository.dashboard = async () => {
    repository.dashboardCalls += 1;
    throw new Error("snapshot unavailable");
  };

  await handleCallback({
    update: callbackUpdate("ppr:p:42:20260727"),
    repository,
    token: "token",
    miniAppUrl: "http://localhost:3000",
    telegramClient: client(calls),
    trace: trace(),
    now: () => new Date("2026-07-27T14:05:00Z")
  });

  assert.equal(repository.payCalls.length, 1);
  assert.match(calls.find((call) => call.method === "editMessageText").text, /Saved:/);
});

test("planned reminder snooze is durable and disable requires confirmation", async () => {
  const repository = fakeRepository();
  const snoozeCalls = [];
  await handleCallback({
    update: callbackUpdate("ppr:s:42:20260727"),
    repository,
    token: "token",
    miniAppUrl: "http://localhost:3000",
    telegramClient: client(snoozeCalls),
    trace: trace(),
    now: () => new Date("2026-07-27T14:05:00Z")
  });
  assert.equal(repository.snoozeCalls[0].nextReminderLocalDate, "2026-07-28");
  const snoozedText = snoozeCalls.find((call) => call.method === "editMessageText").text;
  assert.match(snoozedText, /tomorrow evening/);
  assert.doesNotMatch(snoozedText, /21:00|after \d{1,2}:\d{2}/);

  const disableCalls = [];
  await handleCallback({
    update: callbackUpdate("ppr:d:42:20260727"),
    repository,
    token: "token",
    miniAppUrl: "http://localhost:3000",
    telegramClient: client(disableCalls),
    trace: trace(),
    now: () => new Date("2026-07-27T14:05:00Z")
  });
  assert.equal(repository.disableCalls.length, 0);
  const confirmation = disableCalls.find((call) => call.method === "editMessageText");
  assert.match(confirmation.text, /Disable planned payment “English”/);
  assert.match(confirmation.replyMarkup.inline_keyboard[0][0].callback_data, /^ppr:y:/);
});

test("Russian snooze confirmation promises tomorrow evening without a hardcoded hour", async () => {
  const calls = [];
  const repository = fakeRepository();
  repository.getUserByTelegramId = async () => ({
    id: 1,
    telegram_user_id: 100,
    interface_language: "ru",
    timezone: "Asia/Bangkok"
  });

  await handleCallback({
    update: callbackUpdate("ppr:s:42:20260727"),
    repository,
    token: "token",
    miniAppUrl: "http://localhost:3000",
    telegramClient: client(calls),
    trace: trace(),
    now: () => new Date("2026-07-27T14:05:00Z")
  });

  const snoozedText = calls.find((call) => call.method === "editMessageText").text;
  assert.match(snoozedText, /завтра вечером/);
  assert.doesNotMatch(snoozedText, /21:00|после \d{1,2}:\d{2}/);
});

test("Russian disable confirmation uses unambiguous planned-payment terminology", async () => {
  const calls = [];
  const repository = fakeRepository();
  repository.getUserByTelegramId = async () => ({
    id: 1,
    telegram_user_id: 100,
    interface_language: "ru",
    timezone: "Asia/Bangkok"
  });

  await handleCallback({
    update: callbackUpdate("ppr:d:42:20260727"),
    repository,
    token: "token",
    miniAppUrl: "http://localhost:3000",
    telegramClient: client(calls),
    trace: trace(),
    now: () => new Date("2026-07-27T14:05:00Z")
  });

  const confirmation = calls.find((call) => call.method === "editMessageText");
  assert.match(confirmation.text, /Отключить плановую оплату «English»/);
  assert.doesNotMatch(confirmation.text, /Отключить план «/);
});

function callbackUpdate(data) {
  return {
    callback_query: {
      id: "callback-1",
      data,
      from: { id: 100 },
      message: { chat: { id: 100 }, message_id: 55 }
    }
  };
}

function fakeRepository() {
  return {
    payCalls: [],
    dashboardCalls: 0,
    snoozeCalls: [],
    disableCalls: [],
    async getUserByTelegramId() {
      return { id: 1, telegram_user_id: 100, interface_language: "en", timezone: "Asia/Bangkok" };
    },
    async getPlannedPaymentReminderForTelegramUser() {
      return {
        planned_expense_id: 42,
        occurrence_date: "2026-07-27",
        description: "English",
        amount: 1000,
        currency: "THB",
        recurrence: "monthly",
        active: true,
        paid: false,
        timezone: "Asia/Bangkok",
        interface_language: "en"
      };
    },
    async payPlannedExpenseForTelegramUser(plannedExpenseId, telegramUserId, _paidAt, options) {
      this.payCalls.push({ plannedExpenseId, telegramUserId, occurrenceDate: options.occurrenceDate });
      return {
        id: 99,
        amount_base: 1000,
        amount_original: 1000,
        currency_original: "THB",
        description: "English",
        category_slug: "education",
        budget_impact: "planned",
        spent_at: "2026-07-27T05:00:00Z"
      };
    },
    async dashboard() {
      this.dashboardCalls += 1;
      return {
        snapshot: {
          baseCurrency: "THB",
          today: 1000,
          todayRegular: 0,
          todayPlanned: 1000,
          todayLarge: 0,
          monthlyBudget: 45000,
          monthSpent: 1000,
          plannedMonthPaid: 1000,
          plannedMonthRemaining: 0,
          plannedMonthTotal: 1000
        }
      };
    },
    async markPlannedPaymentReminderTerminal() {},
    async snoozePlannedPaymentReminderForTelegramUser(
      plannedExpenseId,
      telegramUserId,
      occurrenceDate,
      nextReminderLocalDate,
      timezoneUsed
    ) {
      const value = { plannedExpenseId, telegramUserId, occurrenceDate, nextReminderLocalDate, timezoneUsed };
      this.snoozeCalls.push(value);
      return value;
    },
    async deactivatePlannedExpense(...args) {
      this.disableCalls.push(args);
      return { plannedExpense: { id: 42 } };
    },
    async recordAppEvent() {}
  };
}

function client(calls) {
  return {
    async answerCallbackQuery(message) {
      calls.push({ method: "answerCallbackQuery", ...message });
      return { ok: true };
    },
    async editMessageText(message) {
      calls.push({ method: "editMessageText", ...message });
      return { ok: true };
    },
    async sendMessage(message) {
      calls.push({ method: "sendMessage", ...message });
      return { ok: true };
    }
  };
}

function trace() {
  return {
    start() {},
    end() {},
    event() {},
    failActive() {},
    getDurations() { return {}; },
    getMetadata() { return {}; }
  };
}
