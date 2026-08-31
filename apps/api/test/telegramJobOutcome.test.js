import test from "node:test";
import assert from "node:assert/strict";

import { processQueuedMessage } from "../src/telegram.js";
import {
  createTelegramJobDeliveryState,
  markTelegramJobTerminalResponse,
  shouldNotifyTelegramJobFailure
} from "../src/telegramJobOutcome.js";

test("queued job failures remain user-visible until a terminal response is delivered", () => {
  const state = createTelegramJobDeliveryState();
  assert.equal(shouldNotifyTelegramJobFailure(state), true);
  markTelegramJobTerminalResponse(state);
  assert.equal(shouldNotifyTelegramJobFailure(state), false);
});

test("Smart Save returns after the terminal Telegram response even when post-delivery writes hang", async () => {
  const calls = [];
  let draftRefWriteStarted = false;
  let completionAnalyticsStarted = false;
  const never = () => new Promise(() => {});
  const item = {
    amount: 70,
    currency: "THB",
    description: "кофе",
    category_slug: "food_cafe",
    category_source: "parser",
    needs_review: false,
    spent_at: "2026-08-14T08:00:00.000Z",
    budget_impact: "regular"
  };
  const repository = {
    async createDraft(_userId, _text, items) {
      return { id: 42, status: "pending", items };
    },
    async listClosedReserveMonthsForTelegramUser() {
      return [];
    },
    async saveDraftAsExpense(draftId) {
      return {
        expenses: [{
          id: 91,
          draft_id: draftId,
          amount_base: 70,
          amount_original: 70,
          currency_original: "THB",
          description: "кофе",
          category_slug: "food_cafe"
        }],
        dashboardSnapshot: {
          today: 70,
          week: 70,
          month: 70,
          monthlyBudget: 42000,
          remaining: 41930,
          plannedRemaining: 0,
          freeRemaining: 41930,
          budgetProgressPercent: 0.17,
          forecastMonthTotal: 70,
          planDeviation: -41930,
          safeToSpendPerDay: 1352.58,
          status: "below_plan"
        },
        alreadySaved: false
      };
    },
    setDraftMessageRef() {
      draftRefWriteStarted = true;
      return never();
    },
    recordAppEvent(_userId, eventName) {
      if (eventName === "message_processing_completed") {
        completionAnalyticsStarted = true;
        return never();
      }
      return Promise.resolve();
    }
  };
  const telegramClient = {
    async sendMessage(message) {
      calls.push({ method: "sendMessage", ...message });
      return { ok: true, result: { message_id: 501 } };
    },
    async editMessageText(message) {
      calls.push({ method: "editMessageText", ...message });
      return { ok: true, result: { message_id: 501 } };
    },
    async deleteMessage(message) {
      calls.push({ method: "deleteMessage", ...message });
      return { ok: true };
    }
  };
  const trace = {
    start() {},
    end() {},
    event() {},
    failActive() {},
    getDurations() { return {}; },
    getMetadata() { return { llmParse: {} }; }
  };
  const deliveryState = createTelegramJobDeliveryState();

  const processing = processQueuedMessage({
    message: { chat: { id: 10 }, message_id: 77, text: "кофе 70" },
    from: { id: 100 },
    user: {
      id: 1,
      interface_language: "ru",
      onboarding_step: "completed",
      base_currency: "THB",
      timezone: "Asia/Bangkok"
    },
    rawText: "кофе 70",
    hasVoice: false,
    inputType: "text",
    repository,
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    expenseParser: {
      model: "test-model",
      async parse() { return { expenses: [item] }; }
    },
    telegramClient,
    now: () => new Date("2026-08-14T10:00:00.000Z"),
    trace,
    deliveryState
  });

  const result = await Promise.race([
    processing,
    new Promise((_, reject) => setTimeout(() => reject(new Error("processing stayed blocked after terminal response")), 250))
  ]);

  assert.equal(result.result.message_id, 501);
  assert.equal(deliveryState.terminalResponseDelivered, true);
  assert.equal(draftRefWriteStarted, true);
  assert.equal(completionAnalyticsStarted, true);
  assert.equal(calls.filter((call) => call.method === "editMessageText").length, 1);
});
