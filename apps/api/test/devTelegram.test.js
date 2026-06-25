import test from "node:test";
import assert from "node:assert/strict";

import { createTelegramBot } from "../src/telegram.js";
import { buildFakeCallbackUpdate, buildFakeMessageUpdate, createCapturedTelegramClient } from "../src/devTelegram.js";

test("fake Telegram message is processed through bot logic and captures reply markup", async () => {
  const telegramClient = createCapturedTelegramClient();
  const bot = createTelegramBot({
    token: "",
    miniAppUrl: "http://localhost:3000",
    repository: fakeRepository(),
    telegramClient
  });

  await bot.handleUpdate(buildFakeMessageUpdate({ telegramUserId: 100001, text: "coffee 70 baht" }));

  assert.equal(telegramClient.messages.length, 2);
  assert.equal(telegramClient.messages[0].method, "sendMessage");
  assert.match(telegramClient.messages[0].text, /Adding expense/i);
  assert.equal(telegramClient.messages[1].method, "editMessageText");
  assert.match(telegramClient.messages[1].text, /coffee/i);
  assert.equal(telegramClient.messages[1].replyMarkup.inline_keyboard[0][0].callback_data, "d:42:confirm");
});

test("fake callback update is processed through bot logic and captures callback answers", async () => {
  const telegramClient = createCapturedTelegramClient();
  const repository = fakeRepository();
  const bot = createTelegramBot({
    token: "",
    miniAppUrl: "http://localhost:3000",
    repository,
    telegramClient
  });

  await bot.handleUpdate(buildFakeCallbackUpdate({ telegramUserId: 100001, data: "confirm:42" }));

  assert.equal(repository.confirmedDraftId, "42");
  assert.equal(telegramClient.callbackAnswers[0].text, "Saved");
  assert.match(telegramClient.messages[0].text, /Saved|Recorded|today|month/i);
});

test("fake impact callback captures edited draft message", async () => {
  const telegramClient = createCapturedTelegramClient();
  const repository = fakeRepository();
  const bot = createTelegramBot({
    token: "",
    miniAppUrl: "http://localhost:3000",
    repository,
    telegramClient
  });

  await bot.handleUpdate(buildFakeCallbackUpdate({ telegramUserId: 100001, data: "impact:42:0:planned" }));

  assert.equal(repository.updatedItems[0].budget_impact, "planned");
  assert.equal(telegramClient.callbackAnswers[0].text, "Type updated");
  assert.equal(telegramClient.messages[0].method, "editMessageText");
  assert.match(telegramClient.messages[0].text, /planned/i);
});

function fakeRepository() {
  return {
    user: { id: 1, interface_language: "en", base_currency: "THB", onboarding_step: "completed" },
    confirmedDraftId: null,
    updatedItems: null,
    async upsertTelegramUser() {
      return this.user;
    },
    async getUserByTelegramId() {
      return this.user;
    },
    async createDraft(_userId, _sourceText, items) {
      this.items = items;
      return { id: 42 };
    },
    async getDraftForTelegramUser() {
      return {
        id: 42,
        status: "pending",
        items: [{
          amount: 70,
          currency: "THB",
          description: "coffee",
          category_slug: "food_cafe",
          tags: [],
          spent_at: "2026-06-11T09:00:00+07:00",
          confidence: 0.95,
          needs_review: false,
          budget_impact: "regular"
        }]
      };
    },
    async updateDraftItems(_draftId, _telegramUserId, items) {
      this.updatedItems = items;
      return { id: 42, items };
    },
    async confirmDraft(draftId) {
      this.confirmedDraftId = draftId;
      return [{ amount_base: 70 }];
    },
    async dashboard() {
      return {
        snapshot: {
          today: 70,
          week: 1400,
          month: 12000,
          monthlyBudget: 45000,
          remaining: 33000,
          plannedRemaining: 20000,
          freeRemaining: 13000,
          budgetProgressPercent: 26.67,
          forecastMonthTotal: 36000,
          planDeviation: -2000,
          safeToSpendPerDay: 650,
          status: "below_plan"
        }
      };
    }
  };
}
