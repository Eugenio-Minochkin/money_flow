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
  assert.match(edit.text, /── <b>Today<\/b> ──/);
  assert.doesNotMatch(edit.text, /Planned today|Large today|Total today/);
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

test("Telegram disable clears every outstanding exact-occurrence card and disables every reminder state", async () => {
  const calls = [];
  const repository = fakeRepository();
  repository.outstanding = [
    {
      occurrence_date: "2026-07-26",
      tg_chat_id: 100,
      tg_message_id: 55,
      interface_language: "en"
    },
    {
      occurrence_date: "2026-07-27",
      tg_chat_id: 100,
      tg_message_id: 56,
      interface_language: "en"
    }
  ];

  await handleCallback({
    update: callbackUpdate("ppr:y:42:20260726"),
    repository,
    token: "token",
    miniAppUrl: "http://localhost:3000",
    telegramClient: client(calls),
    trace: trace(),
    now: () => new Date("2026-07-27T14:05:00Z")
  });

  const edits = calls.filter((call) => call.method === "editMessageText");
  assert.deepEqual(edits.map((call) => call.messageId), [55, 56]);
  assert.equal(edits.every((call) => call.replyMarkup.inline_keyboard.length === 0), true);
  assert.equal(edits.every((call) => /Planned payment disabled/.test(call.text)), true);
  assert.equal(edits.every((call) => !/Mini App/.test(call.text)), true);
  assert.deepEqual(repository.markAllTerminalCalls, [{
    plannedExpenseId: 42,
    status: "disabled"
  }]);
  assert.equal(repository.markTerminalCalls.length, 0);

  await handleCallback({
    update: callbackUpdate("ppr:y:42:20260727"),
    repository,
    token: "token",
    miniAppUrl: "http://localhost:3000",
    telegramClient: client(calls),
    trace: trace(),
    now: () => new Date("2026-07-27T14:06:00Z")
  });
  assert.match(calls.at(-1).text, /no longer available/);
  assert.deepEqual(calls.at(-1).replyMarkup, { inline_keyboard: [] });
});

test("disable cancellation restores snoozed RU and EN reminder copy", async () => {
  for (const [language, expected, forbidden] of [
    ["ru", /Вы просили напомнить об этой оплате сегодня/, /Оплата запланирована на сегодня/],
    ["en", /You asked to be reminded about this payment today/, /Payment planned for today/]
  ]) {
    const calls = [];
    const repository = fakeRepository();
    repository.getUserByTelegramId = async () => ({
      id: 1,
      telegram_user_id: 100,
      interface_language: language,
      timezone: "Asia/Bangkok"
    });

    await handleCallback({
      update: callbackUpdate("ppr:d:42:20260726"),
      repository,
      token: "token",
      miniAppUrl: "http://localhost:3000",
      telegramClient: client(calls),
      trace: trace(),
      now: () => new Date("2026-07-27T14:05:00Z")
    });
    await handleCallback({
      update: callbackUpdate("ppr:c:42:20260726"),
      repository,
      token: "token",
      miniAppUrl: "http://localhost:3000",
      telegramClient: client(calls),
      trace: trace(),
      now: () => new Date("2026-07-27T14:05:00Z")
    });

    const restored = calls.filter((call) => call.method === "editMessageText").at(-1);
    assert.match(restored.text, expected);
    assert.doesNotMatch(restored.text, forbidden);
    assert.match(JSON.stringify(restored.replyMarkup), /ppr:p:42:20260726/);
  }
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
  const repository = {
    payCalls: [],
    dashboardCalls: 0,
    snoozeCalls: [],
    disableCalls: [],
    markTerminalCalls: [],
    markAllTerminalCalls: [],
    outstanding: [],
    active: true,
    async getUserByTelegramId() {
      return { id: 1, telegram_user_id: 100, interface_language: "en", timezone: "Asia/Bangkok" };
    },
    async getPlannedPaymentReminderForTelegramUser(_plannedExpenseId, _telegramUserId, occurrenceDate) {
      return {
        planned_expense_id: 42,
        occurrence_date: occurrenceDate,
        description: "English",
        amount: 1000,
        currency: "THB",
        recurrence: "monthly",
        active: this.active,
        paid: false,
        timezone: "Asia/Bangkok",
        interface_language: "en",
        last_sent_local_date: occurrenceDate === "2026-07-26" ? "2026-07-27" : occurrenceDate
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
    async markPlannedPaymentReminderTerminal(plannedExpenseId, occurrenceDate, status) {
      this.markTerminalCalls.push({ plannedExpenseId, occurrenceDate, status });
    },
    async markAllPlannedPaymentRemindersTerminal(plannedExpenseId, status) {
      this.markAllTerminalCalls.push({ plannedExpenseId, status });
    },
    async listOutstandingPlannedPaymentReminders() {
      return this.outstanding;
    },
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
      if (!this.active) return null;
      this.active = false;
      return { plannedExpense: { id: 42 } };
    },
    async recordAppEvent() {}
  };
  return repository;
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
