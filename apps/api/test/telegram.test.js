import test from "node:test";
import assert from "node:assert/strict";

import { createTelegramBot } from "../src/telegram.js";

test("text message creates a pending draft response", async () => {
  const calls = [];
  const originalLog = console.log;
  console.log = (...args) => calls.push(args);
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: fakeRepository()
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        text: "кофе 70 бат"
      }
    });

    assert.match(calls[0][1].text, /Я понял так/);
    assert.match(calls[0][1].text, /кофе/);
    assert.equal(calls[0][1].replyMarkup.inline_keyboard[0][0].callback_data, "confirm:42");
  } finally {
    console.log = originalLog;
  }
});

test("confirm callback saves draft and returns totals", async () => {
  const calls = [];
  const repo = fakeRepository();
  const originalLog = console.log;
  console.log = (...args) => calls.push(args);
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: repo
    });

    await bot.handleUpdate({
      callback_query: {
        id: "callback-1",
        data: "confirm:42",
        from: { id: 100 },
        message: { chat: { id: 10 } }
      }
    });

    assert.equal(repo.confirmedDraftId, "42");
    assert.match(calls[0][1].text, /Записал:<\/b> 70 THB/);
    assert.match(calls[0][1].text, /Сегодня:<\/b> 70 THB/);
  } finally {
    console.log = originalLog;
  }
});

test("voice message is transcribed and creates a draft response", async () => {
  const calls = [];
  const originalLog = console.log;
  console.log = (...args) => calls.push(args);
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: fakeRepository(),
      voiceTranscriber: {
        isConfigured: () => true,
        transcribeTelegramVoice: async () => "кофе 70 бат"
      }
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        voice: { file_id: "voice-file-id", mime_type: "audio/ogg" }
      }
    });

    assert.match(calls[0][1].text, /кофе/);
    assert.match(calls[0][1].text, /70 THB/);
    assert.equal(calls[0][1].replyMarkup.inline_keyboard[0][0].callback_data, "confirm:42");
  } finally {
    console.log = originalLog;
  }
});

function fakeRepository() {
  return {
    confirmedDraftId: null,
    async upsertTelegramUser() {
      return { id: 1 };
    },
    async createDraft() {
      return { id: 42 };
    },
    async confirmDraft(draftId) {
      this.confirmedDraftId = draftId;
      return [{ amount_base: 70 }];
    },
    async dashboard() {
      return {
        snapshot: {
          today: 70,
          week: 70,
          month: 70,
          monthlyBudget: 45000,
          remaining: 44930,
          plannedRemaining: 0,
          freeRemaining: 44930,
          safeToSpendPerDay: 1497.67,
          status: "below_plan"
        }
      };
    }
  };
}
