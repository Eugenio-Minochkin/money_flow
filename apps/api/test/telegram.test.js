import test from "node:test";
import assert from "node:assert/strict";

import { createTelegramBot, sendWeeklyReports } from "../src/telegram.js";

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

test("category callback updates the first draft item", async () => {
  const repo = fakeRepository();
  const originalLog = console.log;
  console.log = () => {};
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: repo
    });

    await bot.handleUpdate({
      callback_query: {
        id: "callback-2",
        data: "cat:42:0:health",
        from: { id: 100 },
        message: { chat: { id: 10 } }
      }
    });

    assert.equal(repo.updatedItems[0].category_slug, "health");
  } finally {
    console.log = originalLog;
  }
});

test("amount callback updates the first draft item amount", async () => {
  const repo = fakeRepository();
  const originalLog = console.log;
  console.log = () => {};
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: repo
    });

    await bot.handleUpdate({
      callback_query: {
        id: "callback-3",
        data: "amount:42:0:10",
        from: { id: 100 },
        message: { chat: { id: 10 } }
      }
    });

    assert.equal(repo.updatedItems[0].amount, 80);
  } finally {
    console.log = originalLog;
  }
});

test("weekly reports are sent once per pending user", async () => {
  const calls = [];
  const repo = fakeRepository();
  const originalLog = console.log;
  console.log = (...args) => calls.push(args);
  try {
    await sendWeeklyReports({
      token: "",
      repository: repo,
      miniAppUrl: "http://localhost:3000",
      now: new Date("2026-06-07T20:00:00+07:00")
    });

    assert.equal(repo.markedReportKey, "2026-06-07");
    assert.match(calls[0][1].text, /Ð•Ð¶ÐµÐ½ÐµÐ´ÐµÐ»ÑŒÐ½Ñ‹Ð¹ Ð¾Ñ‚Ñ‡ÐµÑ‚|Еженедельный отчет/);
  } finally {
    console.log = originalLog;
  }
});

test("unclear draft includes category quick actions", async () => {
  const calls = [];
  const originalLog = console.log;
  console.log = (...args) => calls.push(args);
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: fakeRepository(),
      expenseParser: {
        async parse() {
          return {
            expenses: [{
              amount: 800,
              currency: "THB",
              description: "unknown",
              category_slug: "other",
              tags: [],
              spent_at: "2026-06-02T10:00:00+07:00",
              confidence: 0.5,
              needs_review: true
            }]
          };
        }
      }
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        text: "unknown 800"
      }
    });

    const keyboard = calls[0][1].replyMarkup.inline_keyboard.flat();
    assert.ok(keyboard.some((button) => button.callback_data === "cat:42:0:food_cafe"));
  } finally {
    console.log = originalLog;
  }
});

function fakeRepository() {
  return {
    confirmedDraftId: null,
    updatedItems: null,
    markedReportKey: null,
    async upsertTelegramUser() {
      return { id: 1 };
    },
    async createDraft() {
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
          category_slug: "other",
          tags: [],
          spent_at: "2026-06-02T10:00:00+07:00",
          confidence: 0.6,
          needs_review: true
        }]
      };
    },
    async updateDraftItems(_draftId, _telegramUserId, items) {
      this.updatedItems = items;
      return { id: 42, status: "pending", items };
    },
    async confirmDraft(draftId) {
      this.confirmedDraftId = draftId;
      return [{ amount_base: 70 }];
    },
    async listUsersPendingWeeklyReport() {
      return [{ id: 1, telegram_user_id: 100 }];
    },
    async markWeeklyReportSent(_userId, reportKey) {
      this.markedReportKey = reportKey;
    },
    async dashboard() {
      return {
        topCategories: [{ category_slug: "food_cafe", total: 70 }],
        snapshot: {
          today: 70,
          week: 70,
          month: 70,
          monthlyBudget: 45000,
          remaining: 44930,
          plannedRemaining: 0,
          freeRemaining: 44930,
          forecastMonthTotal: 300,
          planDeviation: -1000,
          safeToSpendPerDay: 1497.67,
          status: "below_plan"
        }
      };
    }
  };
}
