import test from "node:test";
import assert from "node:assert/strict";

import { createDailyReminderService } from "../src/dailyReminderService.js";

test("checks every reminder candidate without rollout cohort filtering", async () => {
  const sent = [];
  const users = [
    { id: 1, telegram_user_id: 100, timezone: "Asia/Bangkok", interface_language: "en", created_at: "2026-06-20T00:00:00Z" },
    { id: 2, telegram_user_id: 101, timezone: "Asia/Bangkok", interface_language: "ru", created_at: "2026-06-20T00:00:00Z" }
  ];
  const service = createDailyReminderService({
    repository: fakeRepo(users),
    sendMessage: async (message) => sent.push(message),
    globalEnabled: true,
    now: () => new Date("2026-06-25T15:30:00Z")
  });

  const result = await service.runOnce();

  assert.equal(result.checked, 2);
  assert.equal(result.sent, 2);
  assert.deepEqual(sent.map((message) => message.chatId), [100, 101]);
});

test("sends reminder after 22:00 local time when no activity exists", async () => {
  const sent = [];
  const repo = fakeRepo([{ id: 1, telegram_user_id: 100, timezone: "Asia/Bangkok", interface_language: "en", created_at: "2026-06-20T00:00:00Z" }]);
  const service = createDailyReminderService({
    repository: repo,
    sendMessage: async (message) => sent.push(message),
    globalEnabled: true,
    now: () => new Date("2026-06-25T15:30:00Z")
  });

  const result = await service.runOnce();

  assert.equal(result.sent, 1);
  assert.equal(sent[0].chatId, 100);
  assert.match(sent[0].text, /No entries for today yet/);
  assert.equal(repo.deliveries[0].localDate, "2026-06-25");
  assert.equal(repo.events.some((event) => event.eventName === "daily_reminder_sent"), true);
});

test("does not send before 22:00 local time or when global kill switch is disabled", async () => {
  const user = { id: 1, telegram_user_id: 100, timezone: "Asia/Bangkok", created_at: "2026-06-20T00:00:00Z" };
  const beforeTime = await createDailyReminderService({
    repository: fakeRepo([user]),
    sendMessage: async () => {},
    globalEnabled: true,
    now: () => new Date("2026-06-25T14:30:00Z")
  }).runOnce();
  const killed = await createDailyReminderService({
    repository: fakeRepo([user]),
    sendMessage: async () => {},
    globalEnabled: false,
    now: () => new Date("2026-06-25T15:30:00Z")
  }).runOnce();

  assert.equal(beforeTime.sent, 0);
  assert.equal(killed.sent, 0);
});

test("skips activity, no-spending marks, duplicate delivery, recent delivery and new users", async () => {
  const users = [
    { id: 1, telegram_user_id: 101, timezone: "Asia/Bangkok", created_at: "2026-06-20T00:00:00Z", hasActivity: true },
    { id: 2, telegram_user_id: 102, timezone: "Asia/Bangkok", created_at: "2026-06-20T00:00:00Z", noSpending: true },
    { id: 3, telegram_user_id: 103, timezone: "Asia/Bangkok", created_at: "2026-06-20T00:00:00Z", hasDelivery: true },
    { id: 4, telegram_user_id: 104, timezone: "Asia/Bangkok", created_at: "2026-06-20T00:00:00Z", recentDelivery: true },
    { id: 5, telegram_user_id: 105, timezone: "Asia/Bangkok", created_at: "2026-06-25T00:00:00Z" }
  ];
  const result = await createDailyReminderService({
    repository: fakeRepo(users),
    sendMessage: async () => {},
    globalEnabled: true,
    now: () => new Date("2026-06-25T15:30:00Z")
  }).runOnce();

  assert.equal(result.sent, 0);
});

test("logs timezone fallback events and blocked Telegram errors", async () => {
  const repo = fakeRepo([{ id: 1, telegram_user_id: 100, timezone: "Mars/Olympus", created_at: "2026-06-20T00:00:00Z" }]);
  const blocked = Object.assign(new Error("403 Forbidden: bot was blocked by the user"), { status: 403 });
  const service = createDailyReminderService({
    repository: repo,
    sendMessage: async () => { throw blocked; },
    globalEnabled: true,
    now: () => new Date("2026-06-25T15:30:00Z")
  });

  const result = await service.runOnce();

  assert.equal(result.blocked, 1);
  assert.equal(repo.blockedUsers[0], 1);
  assert.equal(repo.deliveries[0].status, "blocked");
  assert.equal(repo.events.some((event) => event.eventName === "timezone_invalid"), true);
  assert.equal(repo.events.some((event) => event.eventName === "daily_reminder_blocked_or_forbidden"), true);
});

function fakeRepo(users) {
  return {
    users,
    deliveries: [],
    events: [],
    blockedUsers: [],
    async listDailyReminderCandidates() {
      return this.users;
    },
    async hasConfirmedFinancialActivity(userId) {
      return this.users.find((user) => user.id === userId)?.hasActivity === true;
    },
    async hasNoSpendingMark(userId) {
      return this.users.find((user) => user.id === userId)?.noSpending === true;
    },
    async hasDailyReminderDelivery(userId) {
      return this.users.find((user) => user.id === userId)?.hasDelivery === true;
    },
    async hasRecentDailyReminderDelivery(userId) {
      return this.users.find((user) => user.id === userId)?.recentDelivery === true;
    },
    async recordDailyReminderDelivery(input) {
      this.deliveries.push(input);
      return input;
    },
    async recordAppEvent(userId, eventName, metadata) {
      this.events.push({ userId, eventName, metadata });
    },
    async markUserBotBlocked(userId) {
      this.blockedUsers.push(userId);
    }
  };
}
