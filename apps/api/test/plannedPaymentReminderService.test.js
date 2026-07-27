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
  assert.match(sent[0].replyMarkup.inline_keyboard[1][0].text, /Remind me tomorrow/);
});

test("Russian and English reminder terminology is explicit", async () => {
  const { formatPlannedPaymentReminder } = await import("../src/plannedPaymentReminderService.js");
  const ru = formatPlannedPaymentReminder(candidate({ interface_language: "ru" }), "ru");
  const en = formatPlannedPaymentReminder(candidate(), "en");

  assert.match(ru, /Плановая оплата/);
  assert.doesNotMatch(ru, /Сегодня запланирована оплата/);
  assert.match(en, /Payment planned for today/);
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
  return {
    messages,
    async listPlannedPaymentReminderCandidates() {
      return candidates;
    },
    async claimPlannedPaymentReminder(input) {
      const key = `${input.plannedExpenseId}:${input.occurrenceDate}:${input.localDate}`;
      if (claims.has(key)) return null;
      claims.add(key);
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
    async markUserBotBlocked() {}
  };
}
