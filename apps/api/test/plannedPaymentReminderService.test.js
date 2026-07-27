import test from "node:test";
import assert from "node:assert/strict";

test("planned reminder sends a due unpaid occurrence once and records empty-day suppression", async () => {
  const { createPlannedPaymentReminderService } = await import("../src/plannedPaymentReminderService.js");
  const sent = [];
  const repository = fakeRepository([candidate()]);
  const service = createPlannedPaymentReminderService({
    repository,
    sendMessage: async (message) => {
      sent.push(message);
      return { result: { message_id: 77 } };
    },
    globalEnabled: true,
    sendHour: 21,
    miniAppUrl: "https://money.example.com",
    now: () => new Date("2026-07-27T14:00:00Z")
  });

  assert.equal((await service.runOnce()).sent, 1);
  assert.equal((await service.runOnce()).sent, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Payment planned for today/);
  assert.equal(repository.messages[0].telegramMessageId, 77);
  assert.equal(await repository.hasDailyReminderDelivery(1, "2026-07-27", "planned_payment"), true);
});

test("planned reminder skips before configured hour, paid occurrences, and inactive plans", async () => {
  const { createPlannedPaymentReminderService } = await import("../src/plannedPaymentReminderService.js");
  const sent = [];
  const repository = fakeRepository([
    candidate({ id: 10 }),
    candidate({ id: 11, paid_occurrence_dates: ["2026-07-27"] }),
    candidate({ id: 12, active: false })
  ]);
  const service = createPlannedPaymentReminderService({
    repository,
    sendMessage: async (message) => sent.push(message),
    globalEnabled: true,
    sendHour: 21,
    miniAppUrl: "https://money.example.com",
    now: () => new Date("2026-07-27T13:59:00Z")
  });

  assert.equal((await service.runOnce()).sent, 0);
  assert.equal(sent.length, 0);
});

test("snoozed occurrence is sent next day while an ignored occurrence is not", async () => {
  const { createPlannedPaymentReminderService } = await import("../src/plannedPaymentReminderService.js");
  const sent = [];
  const repository = fakeRepository([
    candidate({
      id: 10,
      due_day: 26,
      reminder_states: [{
        occurrence_date: "2026-07-26",
        next_reminder_local_date: "2026-07-27",
        last_sent_local_date: "2026-07-26",
        status: "active"
      }]
    }),
    candidate({
      id: 11,
      due_day: 26,
      reminder_states: [{
        occurrence_date: "2026-07-26",
        next_reminder_local_date: null,
        last_sent_local_date: "2026-07-26",
        status: "active"
      }]
    })
  ]);
  const service = createPlannedPaymentReminderService({
    repository,
    sendMessage: async (message) => {
      sent.push(message);
      return { result: { message_id: 88 } };
    },
    globalEnabled: true,
    sendHour: 21,
    miniAppUrl: "https://money.example.com",
    now: () => new Date("2026-07-27T14:00:00Z")
  });

  assert.equal((await service.runOnce()).sent, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /You asked to be reminded about this payment today\. Have you paid it\?/);
  assert.doesNotMatch(sent[0].text, /Payment planned for today/);
  assert.match(sent[0].replyMarkup.inline_keyboard[1][0].text, /Remind me tomorrow/);
});

test("temporary send failure releases the claim and the next tick sends exactly once", async () => {
  const { createPlannedPaymentReminderService } = await import("../src/plannedPaymentReminderService.js");
  const sent = [];
  let attempts = 0;
  const repository = fakeRepository([candidate()]);
  const service = createPlannedPaymentReminderService({
    repository,
    sendMessage: async (message) => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary Telegram failure");
      sent.push(message);
      return { result: { message_id: 91 } };
    },
    globalEnabled: true,
    sendHour: 21,
    miniAppUrl: "https://money.example.com",
    now: () => new Date("2026-07-27T14:00:00Z")
  });

  assert.equal((await service.runOnce()).failed, 1);
  assert.equal((await service.runOnce()).sent, 1);
  assert.equal((await service.runOnce()).sent, 0);
  assert.equal(attempts, 2);
  assert.equal(sent.length, 1);
  assert.equal(repository.releaseCalls.length, 1);
});

test("blocked or forbidden send failure is not retried", async () => {
  const { createPlannedPaymentReminderService } = await import("../src/plannedPaymentReminderService.js");
  let attempts = 0;
  const repository = fakeRepository([candidate()]);
  const service = createPlannedPaymentReminderService({
    repository,
    sendMessage: async () => {
      attempts += 1;
      const error = new Error("Forbidden: bot was blocked by the user");
      error.status = 403;
      throw error;
    },
    globalEnabled: true,
    sendHour: 21,
    miniAppUrl: "https://money.example.com",
    now: () => new Date("2026-07-27T14:00:00Z")
  });

  assert.equal((await service.runOnce()).blocked, 1);
  assert.equal((await service.runOnce()).blocked, 0);
  assert.equal(attempts, 1);
  assert.equal(repository.releaseCalls.length, 0);
});

test("post-send persistence failure keeps the claim and does not duplicate the Telegram card", async () => {
  const { createPlannedPaymentReminderService } = await import("../src/plannedPaymentReminderService.js");
  let attempts = 0;
  const repository = fakeRepository([candidate()]);
  repository.recordPlannedPaymentReminderMessage = async () => {
    throw new Error("temporary database failure after send");
  };
  const service = createPlannedPaymentReminderService({
    repository,
    sendMessage: async () => {
      attempts += 1;
      return { result: { message_id: 92 } };
    },
    globalEnabled: true,
    sendHour: 21,
    miniAppUrl: "https://money.example.com",
    now: () => new Date("2026-07-27T14:00:00Z")
  });

  assert.equal((await service.runOnce()).failed, 1);
  assert.equal((await service.runOnce()).sent, 0);
  assert.equal(attempts, 1);
  assert.equal(repository.releaseCalls.length, 0);
});

test("snoozed and due-today occurrences of one twice-monthly plan are sent separately in date order", async () => {
  const { createPlannedPaymentReminderService } = await import("../src/plannedPaymentReminderService.js");
  const sent = [];
  const repository = fakeRepository([candidate({
    recurrence: "twice_monthly",
    due_day: null,
    due_days: [26, 27],
    reminder_states: [{
      occurrence_date: "2026-07-26",
      next_reminder_local_date: "2026-07-27",
      last_sent_local_date: "2026-07-26",
      status: "active"
    }]
  })]);
  const service = createPlannedPaymentReminderService({
    repository,
    sendMessage: async (message) => {
      sent.push(message);
      return { result: { message_id: 100 + sent.length } };
    },
    globalEnabled: true,
    sendHour: 21,
    miniAppUrl: "https://money.example.com",
    now: () => new Date("2026-07-27T14:00:00Z")
  });

  assert.equal((await service.runOnce()).sent, 2);
  assert.equal(sent.length, 2);
  assert.match(JSON.stringify(sent[0].replyMarkup), /20260726/);
  assert.match(JSON.stringify(sent[1].replyMarkup), /20260727/);
  assert.match(sent[0].text, /You asked to be reminded/);
  assert.match(sent[1].text, /Payment planned for today/);
});

test("Russian and English reminder terminology is explicit", async () => {
  const { formatPlannedPaymentReminder } = await import("../src/plannedPaymentReminderService.js");
  const ru = formatPlannedPaymentReminder(candidate({ interface_language: "ru" }), "ru");
  const en = formatPlannedPaymentReminder(candidate(), "en");
  const snoozedRu = formatPlannedPaymentReminder(candidate(), "ru", { deliveryReason: "snoozed" });
  const snoozedEn = formatPlannedPaymentReminder(candidate(), "en", { deliveryReason: "snoozed" });

  assert.match(ru, /Плановая оплата/);
  assert.doesNotMatch(ru, /Сегодня запланирована оплата/);
  assert.match(en, /Payment planned for today/);
  assert.match(snoozedRu, /Вы просили напомнить об этой оплате сегодня\. Уже оплатили\?/);
  assert.doesNotMatch(snoozedRu, /Оплата запланирована на сегодня/);
  assert.match(snoozedEn, /You asked to be reminded about this payment today\. Have you paid it\?/);
  assert.doesNotMatch(snoozedEn, /Payment planned for today/);
});

test("configured hour follows the user's timezone across a DST boundary", async () => {
  const { createPlannedPaymentReminderService } = await import("../src/plannedPaymentReminderService.js");
  const sent = [];
  const repository = fakeRepository([candidate({
    timezone: "America/New_York",
    recurrence: "one_off",
    due_date: "2026-03-08"
  })]);
  const before = createPlannedPaymentReminderService({
    repository,
    sendMessage: async (message) => sent.push(message),
    globalEnabled: true,
    sendHour: 21,
    miniAppUrl: "https://money.example.com",
    now: () => new Date("2026-03-09T00:59:00Z")
  });
  const after = createPlannedPaymentReminderService({
    repository,
    sendMessage: async (message) => {
      sent.push(message);
      return { result: { message_id: 90 } };
    },
    globalEnabled: true,
    sendHour: 21,
    miniAppUrl: "https://money.example.com",
    now: () => new Date("2026-03-09T01:00:00Z")
  });

  assert.equal((await before.runOnce()).sent, 0);
  assert.equal((await after.runOnce()).sent, 1);
});

function candidate(overrides = {}) {
  return {
    id: 10,
    user_id: 1,
    telegram_user_id: 100,
    timezone: "Asia/Bangkok",
    interface_language: "en",
    description: "English",
    amount: 1000,
    currency: "THB",
    recurrence: "monthly",
    due_day: 27,
    due_days: null,
    weekday: null,
    due_date: null,
    starts_on: null,
    active: true,
    paid_occurrence_dates: [],
    reminder_states: [],
    ...overrides
  };
}

function fakeRepository(candidates) {
  const claims = new Set();
  const messages = [];
  const deliveries = [];
  const releaseCalls = [];
  const blockedUsers = new Set();
  return {
    messages,
    releaseCalls,
    async listPlannedPaymentReminderCandidates() {
      return candidates.filter((item) => !blockedUsers.has(item.user_id));
    },
    async claimPlannedPaymentReminder(input) {
      const key = `${input.plannedExpenseId}:${input.occurrenceDate}:${input.localDate}`;
      if (claims.has(key)) return null;
      claims.add(key);
      return input;
    },
    async releasePlannedPaymentReminderClaim(input) {
      releaseCalls.push(input);
      claims.delete(`${input.plannedExpenseId}:${input.occurrenceDate}:${input.localDate}`);
      return input;
    },
    async recordPlannedPaymentReminderMessage(input) {
      messages.push(input);
      return input;
    },
    async recordAppEvent() {},
    async recordDailyReminderDelivery(input) {
      deliveries.push(input);
    },
    async hasDailyReminderDelivery(userId, localDate, reminderType) {
      return deliveries.some((item) => item.userId === userId
        && item.localDate === localDate
        && item.reminderType === reminderType);
    },
    async markUserBotBlocked(userId) {
      blockedUsers.add(userId);
    }
  };
}
