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

test("confirm callback saves draft and returns an informative summary", async () => {
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
    assert.match(calls[0][1].text, /Записал/);
    assert.match(calls[0][1].text, /<b>Сегодня<\/b>/);
    assert.match(calls[0][1].text, /<b>Месяц<\/b>/);
    assert.match(calls[0][1].text.replaceAll("\u00a0", " "), /Потрачено:<\/b> 735 THB \/ 42 000 THB/);
    assert.match(calls[0][1].text, /1,75%/);
    assert.match(calls[0][1].text, /Плановые сегодня/);
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

test("text parsing uses user's base currency as default", async () => {
  const seenOptions = [];
  const repository = {
    ...fakeRepository(),
    async upsertTelegramUser() {
      return { id: 1, interface_language: "en", base_currency: "IDR" };
    }
  };
  const originalLog = console.log;
  console.log = () => {};
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository,
      expenseParser: {
        async parse(_text, options) {
          seenOptions.push(options);
          return {
            expenses: [{
              amount: 14000,
              currency: options.defaultCurrency,
              description: "coffee",
              category_slug: "food_cafe",
              tags: [],
              spent_at: "2026-06-02T10:00:00+07:00",
              confidence: 0.9,
              needs_review: false
            }]
          };
        }
      }
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        text: "coffee 14k"
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(seenOptions[0].defaultCurrency, "IDR");
});

test("new user onboarding asks currency, budget, and opening spend in order", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.user = { id: 1, interface_language: "en", base_currency: "THB", onboarding_step: "base_currency" };
  const originalLog = console.log;
  console.log = (...args) => calls.push(args);
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: repo
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        text: "/start"
      }
    });
    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        text: "IDR"
      }
    });
    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        text: "20k"
      }
    });
    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        text: "1500"
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.match(calls[0][1].text, /base currency/i);
  assert.match(calls[1][1].text, /monthly budget/i);
  assert.match(calls[2][1].text, /spent from the 1st/i);
  assert.match(calls[3][1].text, /setup is complete/i);
  assert.equal(repo.settings.baseCurrency, "IDR");
  assert.equal(repo.settings.monthlyBudgetAmount, 20000);
  assert.equal(repo.monthBaseline.amount, 1500);
});

test("recurring planned text creates a planned draft before saving", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.user = { id: 1, interface_language: "en", base_currency: "THB", onboarding_step: "completed" };
  const originalLog = console.log;
  console.log = (...args) => calls.push(args);
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: repo
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        text: "every Tuesday psychologist 5000 rub"
      }
    });

    await bot.handleUpdate({
      callback_query: {
        id: "callback-plan",
        data: "plan_confirm:77",
        from: { id: 100 },
        message: { chat: { id: 10 } }
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(repo.plannedDraft.item.recurrence, "weekly");
  assert.equal(repo.plannedDraft.item.weekday, 2);
  assert.equal(repo.plannedDraft.item.currency, "RUB");
  assert.match(calls[0][1].text, /Planned expense/i);
  assert.equal(calls[0][1].replyMarkup.inline_keyboard[0][0].callback_data, "plan_confirm:77");
  assert.equal(repo.confirmedPlannedDraftId, "77");
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

test("impact callback updates the draft item and edits the existing Telegram message", async () => {
  const requests = [];
  const repo = fakeRepository();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, request) => {
    requests.push({ url: String(url), body: JSON.parse(request.body) });
    return {
      ok: true,
      async json() {
        return { ok: true };
      }
    };
  };
  try {
    const bot = createTelegramBot({
      token: "test-token",
      miniAppUrl: "http://localhost:3000",
      repository: repo
    });

    await bot.handleUpdate({
      callback_query: {
        id: "callback-impact",
        data: "impact:42:0:large_oneoff",
        from: { id: 100 },
        message: { chat: { id: 10 }, message_id: 99 }
      }
    });

    assert.equal(repo.updatedItems[0].budget_impact, "large_oneoff");
    assert.ok(requests.some((request) => request.url.endsWith("/answerCallbackQuery")));
    const edit = requests.find((request) => request.url.endsWith("/editMessageText"));
    assert.ok(edit);
    assert.equal(edit.body.chat_id, 10);
    assert.equal(edit.body.message_id, 99);
    assert.ok(edit.body.reply_markup.inline_keyboard.flat().some((button) => button.text === "☑️ Крупная"));
  } finally {
    globalThis.fetch = originalFetch;
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
    assert.match(calls[0][1].text, /Еженедельный отчет/);
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

test("move to inbox callback returns a direct mini app draft link", async () => {
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
        id: "callback-inbox",
        data: "inbox:42",
        from: { id: 100 },
        message: { chat: { id: 10 } }
      }
    });
  } finally {
    console.log = originalLog;
  }

  const keyboard = calls[0][1].replyMarkup.inline_keyboard.flat();
  assert.ok(keyboard.some((button) => button.web_app?.url === "http://localhost:3000?telegramUserId=100&draftId=42"));
});

function fakeRepository() {
  return {
    user: { id: 1, interface_language: "ru", onboarding_step: "completed" },
    confirmedDraftId: null,
    confirmedPlannedDraftId: null,
    updatedItems: null,
    markedReportKey: null,
    settings: {},
    monthBaseline: null,
    plannedDraft: null,
    async upsertTelegramUser() {
      return this.user;
    },
    async getUserByTelegramId() {
      return this.user;
    },
    async updateUserSettings(_telegramUserId, settings) {
      this.settings = { ...this.settings, ...settings };
      this.user = {
        ...this.user,
        base_currency: settings.baseCurrency ?? this.user.base_currency,
        monthly_budget_amount: settings.monthlyBudgetAmount ?? this.user.monthly_budget_amount,
        display_currency: settings.displayCurrency ?? this.user.display_currency,
        interface_language: settings.interfaceLanguage ?? this.user.interface_language,
        onboarding_step: settings.onboardingStep ?? this.user.onboarding_step
      };
      return this.user;
    },
    async setOnboardingStep(_telegramUserId, step) {
      this.user = { ...this.user, onboarding_step: step };
      return this.user;
    },
    async setMonthBaseline(_telegramUserId, baseline) {
      this.monthBaseline = baseline;
      return baseline;
    },
    async createPlannedDraft(_userId, _sourceText, item) {
      this.plannedDraft = { id: 77, item };
      return this.plannedDraft;
    },
    async confirmPlannedDraft(draftId) {
      this.confirmedPlannedDraftId = draftId;
      return { id: 88, ...this.plannedDraft.item };
    },
    async cancelPlannedDraft() {
      return null;
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
      return [{ amount_base: 75 }];
    },
    async moveDraftToInbox() {
      return null;
    },
    async listUsersPendingWeeklyReport() {
      return [{ id: 1, telegram_user_id: 100, interface_language: "ru" }];
    },
    async markWeeklyReportSent(_userId, reportKey) {
      this.markedReportKey = reportKey;
    },
    async dashboard() {
      return {
        topCategories: [{ category_slug: "food_cafe", total: 735 }],
        snapshot: {
          today: 75,
          week: 735,
          month: 735,
          monthlyBudget: 42000,
          remaining: 41265,
          plannedRemaining: 15269.99,
          freeRemaining: 25995.01,
          budgetProgressPercent: 1.75,
          forecastMonthTotal: 11025,
          planDeviation: -2065,
          safeToSpendPerDay: 896.38,
          status: "below_plan"
        }
      };
    }
  };
}
