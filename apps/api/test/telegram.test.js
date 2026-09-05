import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parseAdminTelegramIds } from "../src/adminAccess.js";
import { createExpenseParser } from "../src/expenseParser.js";
import { createTelegramBot, processQueuedMessage, sendTelegramMessage, sendWeeklyReports } from "../src/telegram.js";
import { buildTelegramCommandMenu } from "../src/telegramCommands.js";
import { CategoryRequiredError, DraftCanceledError } from "../src/repository.js";

test("exports the Telegram message sender used by the production server", async () => {
  const calls = [];
  const telegramClient = {
    async sendMessage(message) {
      calls.push(message);
      return { ok: true, result: { message_id: 42 } };
    }
  };
  const replyMarkup = { inline_keyboard: [[{ text: "Open", url: "https://example.com" }]] };
  const replyParameters = { message_id: 21, allow_sending_without_reply: true };

  const result = await sendTelegramMessage({
    token: "unused-with-client",
    chatId: 100,
    text: "Release digest",
    replyMarkup,
    replyParameters,
    telegramClient
  });

  assert.deepEqual(calls, [{ chatId: 100, text: "Release digest", replyMarkup, replyParameters }]);
  assert.deepEqual(result, { ok: true, result: { message_id: 42 } });
});

test("Telegram message sender maps native reply parameters to the Bot API body", async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, async json() { return { ok: true, result: { message_id: 42 } }; } };
  };

  try {
    await sendTelegramMessage({
      token: "test-token",
      chatId: 100,
      text: "Reply",
      replyParameters: { message_id: 21, allow_sending_without_reply: true }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.match(requests[0].url, /\/sendMessage$/);
  assert.deepEqual(requests[0].body.reply_parameters, {
    message_id: 21,
    allow_sending_without_reply: true
  });
});
test("new /start records the entry before showing and recording onboarding", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.user = {
    id: 1,
    interface_language: "en",
    onboarding_step: "language",
    is_new: true
  };
  repo.upsertTelegramUser = async (input) => {
    calls.push({ name: "upsert", input });
    return repo.user;
  };
  repo.clearTelegramUserBotBlocked = async (telegramUserId, options) => {
    calls.push({ name: "clearBlocked", telegramUserId, options });
    return { changed: false };
  };
  repo.recordAppEvent = async (userId, eventName, metadata) => {
    calls.push({ name: `event:${eventName}`, userId, metadata });
  };
  repo.recordAppEventOnce = async (userId, eventName, metadata) => {
    calls.push({ name: `once:${eventName}`, userId, metadata });
    return { recorded: true };
  };
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: {
      async sendMessage(message) {
        calls.push({ name: "sendMessage", message });
        return { ok: true };
      }
    }
  });

  await bot.handleUpdate(textUpdate("/start Friend_Alex", 100));

  assert.deepEqual(calls.map((call) => call.name), [
    "upsert",
    "clearBlocked",
    "event:bot_started",
    "sendMessage",
    "once:onboarding_started"
  ]);
  assert.equal(calls[0].input.acquisitionSource, "friend_alex");
  assert.deepEqual(calls[2].metadata, { source: "friend_alex" });
  assert.deepEqual(calls[4].metadata, { source: "telegram" });
});

test("private chat member transitions update blocked state without creating a user", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.setTelegramUserBotBlocked = async (telegramUserId, options) => {
    calls.push({ telegramUserId, options });
    return { changed: true };
  };
  const bot = createTelegramBot({ token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo });

  await bot.handleUpdate({
    my_chat_member: {
      chat: { id: 100, type: "private" },
      from: { id: 100 },
      old_chat_member: { status: "member" },
      new_chat_member: { status: "kicked" }
    }
  });

  assert.deepEqual(calls, [{
    telegramUserId: 100,
    options: { blocked: true, source: "telegram_status", now: calls[0].options.now }
  }]);
});

test("chat member updates ignore groups and repeated availability states", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.setTelegramUserBotBlocked = async (...args) => calls.push(args);
  const bot = createTelegramBot({ token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo });

  await bot.handleUpdate({ my_chat_member: { chat: { id: -100, type: "group" }, old_chat_member: { status: "member" }, new_chat_member: { status: "kicked" } } });
  await bot.handleUpdate({ my_chat_member: { chat: { id: 100, type: "private" }, old_chat_member: { status: "member" }, new_chat_member: { status: "member" } } });

  assert.deepEqual(calls, []);
});

test("safe text message is saved immediately with edit and delete actions", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.listClosedReserveMonthsForTelegramUser = async () => [];
  repo.saveDraftAsExpense = async (draftId) => ({
    expenses: [{ id: 91, draft_id: draftId, amount_base: 70, amount_original: 70, currency_original: "THB", description: "кофе", category_slug: "food_cafe" }],
    dashboardSnapshot: (await repo.dashboard()).snapshot,
    alreadySaved: false
  });
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    expenseParser: { async parse() { return { expenses: [{ amount: 70, currency: "THB", description: "кофе", category_slug: "food_cafe", category_source: "parser", needs_review: false, spent_at: "2026-08-14T08:00:00.000Z", budget_impact: "regular" }] }; } },
    telegramClient: capturingClient(calls)
  });

  await bot.handleUpdate({ message: { message_id: 55, chat: { id: 10 }, from: { id: 100, first_name: "M" }, text: "кофе 70 бат" } });

  const saved = calls.find((call) => ["sendMessage", "editMessageText"].includes(call.method) && /Записал/.test(call.text));
  assert.ok(saved);
  assert.match(saved.text, /кофе/);
  assert.equal(saved.replyMarkup.inline_keyboard[0][0].callback_data, "ee:x:91:o");
  assert.equal(saved.replyMarkup.inline_keyboard[0][1].callback_data, "ee:x:91:del");
  assert.equal(repo.events.filter((event) => event.eventName === "expense_saved").length, 1);
});

test("safe voice message is saved immediately", async () => {
  const calls = [];
  const parsedTexts = [];
  const repo = fakeRepository();
  repo.listClosedReserveMonthsForTelegramUser = async () => [];
  repo.saveDraftAsExpense = async (draftId) => ({
    expenses: [{ id: 92, draft_id: draftId, amount_base: 460, amount_original: 460, currency_original: "THB", description: "такси", category_slug: "transport" }],
    dashboardSnapshot: (await repo.dashboard()).snapshot,
    alreadySaved: false
  });
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo,
    voiceTranscriber: { isConfigured: () => true, async transcribeTelegramVoice() { return "Такси 8:50 лари"; } },
    expenseParser: { async parse(text) { parsedTexts.push(text); return { expenses: [{ amount: 8.5, currency: "GEL", description: "такси", category_slug: "transport", category_source: "parser", needs_review: false, spent_at: "2026-08-14T08:00:00.000Z", budget_impact: "regular" }] }; } },
    telegramClient: capturingClient(calls)
  });

  await bot.handleUpdate({ message: { message_id: 56, chat: { id: 10 }, from: { id: 100, first_name: "M" }, voice: { file_id: "voice-1", mime_type: "audio/ogg" } } });

  assert.ok(calls.some((call) => ["sendMessage", "editMessageText"].includes(call.method) && /Записал/.test(call.text)));
  assert.deepEqual(parsedTexts, ["Такси 8.50 лари"]);
  assert.equal(repo.events.filter((event) => event.eventName === "expense_saved").length, 1);
});

test("completed Telegram webhook replay removes only its new loader and keeps the original result reference", async () => {
  const calls = [];
  const repo = fakeRepository();
  const storedDraft = {
    id: 42,
    status: "confirmed",
    tg_chat_id: 10,
    tg_message_id: 900,
    items: [{ amount: 70, currency: "THB", description: "кофе", category_slug: "food_cafe", category_source: "parser", needs_review: false, spent_at: "2026-08-14T08:00:00.000Z", budget_impact: "regular" }]
  };
  repo.claimTelegramExpenseCapture = async () => ({ state: "completed", draft: storedDraft });
  repo.getDraftForTelegramUser = async () => storedDraft;
  repo.saveDraftAsExpense = async () => { throw new Error("replay must not save again"); };
  const telegramClient = {
    ...capturingClient(calls),
    async sendMessage(message) {
      calls.push({ method: "sendMessage", ...message });
      return { result: { message_id: 301 } };
    }
  };
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo,
    expenseParser: { async parse() { throw new Error("replay must not parse again"); } },
    telegramClient
  });

  await bot.handleUpdate({ message: { message_id: 58, chat: { id: 10 }, from: { id: 100, first_name: "M" }, text: "кофе 70 бат" } });

  assert.deepEqual(calls.map((call) => call.method), ["sendMessage", "deleteMessage"]);
  assert.equal(calls[1].messageId, 301);
  assert.equal(repo.events.some((event) => ["expense_draft_created", "expense_saved"].includes(event.eventName)), false);
});

test("ambiguous Telegram expense remains in review and explains category choice", async () => {
  const calls = [];
  const repo = fakeRepository();
  let saves = 0;
  repo.listClosedReserveMonthsForTelegramUser = async () => [];
  repo.saveDraftAsExpense = async () => { saves += 1; throw new Error("must not save"); };
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo,
    expenseParser: { async parse() { return { expenses: [{ amount: 800, currency: "THB", description: "непонятно", category_slug: "other", category_source: "parser", needs_review: false, spent_at: "2026-08-14T08:00:00.000Z", budget_impact: "regular" }] }; } },
    telegramClient: capturingClient(calls)
  });

  await bot.handleUpdate({ message: { message_id: 57, chat: { id: 10 }, from: { id: 100, first_name: "M" }, text: "непонятно 800 бат" } });

  assert.equal(saves, 0);
  const review = calls.find((call) => ["sendMessage", "editMessageText"].includes(call.method) && /категори/i.test(call.text));
  assert.ok(review);
});

test("initial mixed text and voice drafts use the prepared converted preview", async (t) => {
  for (const inputType of ["text", "voice"]) {
    await t.test(inputType, async () => {
      const calls = [];
      const previewCalls = [];
      const repo = fakeRepository();
      repo.user = { ...repo.user, interface_language: "en", base_currency: "USD" };
      repo.prepareDraftPreview = async (items, user) => {
        previewCalls.push({ items, user });
        return { kind: "converted", baseCurrency: "USD", total: inputType === "text" ? 31.25 : 32.5 };
      };
      const expenses = [
        {
          amount: 10,
          currency: "USD",
          description: "coffee",
          category_slug: "food_cafe",
          spent_at: "2026-07-20T08:00:00.000Z",
          budget_impact: "regular"
        },
        {
          amount: 20,
          currency: "EUR",
          description: "lunch",
          category_slug: "food_cafe",
          spent_at: "2026-07-20T12:00:00.000Z",
          budget_impact: "regular"
        }
      ];
      const bot = createTelegramBot({
        token: "test-token",
        miniAppUrl: "http://localhost:3000",
        repository: repo,
        expenseParser: {
          async parse() {
            return { expenses, notes: [] };
          }
        },
        voiceTranscriber: {
          isConfigured: () => true,
          async transcribeTelegramVoice() {
            return "coffee 10 dollars and lunch 20 euros";
          }
        },
        telegramClient: capturingClient(calls)
      });

      await bot.handleUpdate({
        message: {
          chat: { id: 10 },
          from: { id: 100, first_name: "M" },
          ...(inputType === "text"
            ? { text: "coffee 10 dollars and lunch 20 euros" }
            : { voice: { file_id: "voice-file-id", mime_type: "audio/ogg" } })
        }
      });

      assert.equal(previewCalls.length, 1);
      assert.equal(previewCalls[0].items, expenses);
      assert.equal(previewCalls[0].user, repo.user);
      const card = calls.find((call) => /<b>Total:<\/b>/.test(call.text ?? ""));
      assert.ok(card, "expected a delivered draft card");
      assert.match(card.text, inputType === "text" ? /31\.25 USD/ : /32\.50 USD/);
      assert.doesNotMatch(card.text, /reliable total.*unavailable/i);
    });
  }
});

test("normal text message records received draft and processing events", async () => {
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
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        text: "coffee 70 baht"
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(repo.events.slice(0, 2), [
    { userId: 1, eventName: "message_received", metadata: { inputType: "text" } },
    { userId: 1, eventName: "expense_draft_created", metadata: { inputType: "text", draftType: "regular" } }
  ]);
  assert.equal(repo.events[2].eventName, "expense_saved");
  assert.equal(repo.events[3].eventName, "message_processing_completed");
  assert.equal(repo.events[3].metadata.inputType, "text");
  assert.equal(Number.isFinite(repo.events[3].metadata.processingTotalMs), true);
});

test("message processing completed event includes stage performance metadata", async () => {
  const repo = fakeRepository();
  const originalLog = console.log;
  console.log = () => {};
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      expenseParser: {
        model: "gpt-test",
        async parse(_text, options = {}) {
          options.onLlmTrace?.({
            model: "gpt-test",
            promptChars: 123,
            responseChars: 45,
            fallback: "local-parser"
          });
          return {
            expenses: [{
              amount: 70,
              currency: "THB",
              description: "coffee",
              category_slug: "food",
              tags: [],
              spent_at: "2026-06-15T10:00:00.000Z",
              budget_impact: "regular",
              confidence: 0.9,
              needs_review: false
            }],
            notes: []
          };
        }
      },
      voiceTranscriber: {
        isConfigured: () => true,
        async transcribeTelegramVoice(_voice, options = {}) {
          options.onPerfStage("telegram_file_download_start", { audioDurationSec: 3 });
          options.onPerfStage("telegram_file_download_end", { audioDurationSec: 3, fileSizeKb: 12 });
          options.onPerfStage("transcription_start", { transcriptionProvider: "deepgram" });
          options.onPerfStage("transcription_end", { transcriptionProvider: "deepgram", responseChars: 11 });
          return "coffee 70 baht";
        }
      }
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        voice: { file_id: "voice-file-id", mime_type: "audio/ogg", duration: 3 }
      }
    });
  } finally {
    console.log = originalLog;
  }

  const completed = repo.events.find((event) => event.eventName === "message_processing_completed");
  assert.equal(completed.metadata.inputType, "voice");
  assert.equal(completed.metadata.audioDurationSec, 3);
  assert.equal(completed.metadata.model, "gpt-test");
  assert.equal(completed.metadata.promptChars, 123);
  assert.equal(completed.metadata.responseChars, 45);
  assert.equal(completed.metadata.fallback, "local-parser");
  assert.equal(Number.isFinite(completed.metadata.processingTotalMs), true);
  assert.equal(Number.isFinite(completed.metadata.telegramResponseMs), true);
  assert.equal(Number.isFinite(completed.metadata.telegramFileDownloadMs), true);
  assert.equal(Number.isFinite(completed.metadata.transcriptionMs), true);
  assert.equal(Number.isFinite(completed.metadata.llmParseMs), true);
  assert.equal(Number.isFinite(completed.metadata.dbSaveMs), true);
});

test("successful draft processing records a completed result", async () => {
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
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        text: "coffee 70 baht"
      }
    });
  } finally {
    console.log = originalLog;
  }

  const completed = repo.events.find((event) => event.eventName === "message_processing_completed");
  assert.equal(completed.metadata.result, "expense_saved");
  assert.equal(completed.metadata.status, "expense_saved");
  assert.equal(completed.metadata.draftType, "regular");
  assert.equal(completed.metadata.inputType, "text");
});

test("admin stats command is excluded from regular message events", async () => {
  const repo = fakeRepository();
  const originalLog = console.log;
  console.log = () => {};
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      adminTelegramIds: new Set([100]),
      adminStatsService: {
        async getAdminStats() {
          return {
            today: emptyAdminPeriod(),
            last7Days: emptyAdminPeriod(),
            last30Days: emptyAdminPeriod()
          };
        }
      }
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        text: "/admin_stats"
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(repo.events, []);
});

test("/export shows expense export period choices", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.user = { ...repo.user, interface_language: "en" };
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: capturingClient(calls)
  });

  await bot.handleUpdate({
    message: {
      chat: { id: 10 },
      from: { id: 100, first_name: "M" },
      text: "/export"
    }
  });

  const message = calls.find((call) => call.method === "sendMessage");
  assert.ok(message);
  assert.match(message.text, /Export expenses/i);
  assert.deepEqual(message.replyMarkup, {
    inline_keyboard: [
      [{ text: "Current month", callback_data: "export:month" }],
      [{ text: "All time", callback_data: "export:all" }]
    ]
  });
});

test("/last shows the saved expense card with edit and delete actions", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.getLatestEditableExpenseForTelegramUser = async () => ({
    id: 91,
    amount_base: 120,
    amount_original: 120,
    currency_original: "THB",
    description: "coffee",
    category_slug: "food_cafe",
    tags: [],
    spent_at: "2026-07-15T10:00:00.000Z"
  });
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient: capturingClient(calls)
  });

  await bot.handleUpdate(textUpdate("/last", 100));

  const message = calls.find((call) => call.method === "sendMessage");
  assert.ok(message);
  assert.match(message.text, /Записал|Saved/);
  assert.deepEqual(message.replyMarkup.inline_keyboard.map((row) => row.map((button) => button.callback_data ?? button.web_app?.url)), [
    ["ee:x:91:o", "ee:x:91:del"],
    ["http://localhost:3000?telegramUserId=100"]
  ]);
});

test("editor Save returns a saved expense to its summary card", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.getExpenseForTelegramUser = async () => ({
    id: 91,
    amount_base: 120,
    amount_original: 120,
    currency_original: "THB",
    description: "coffee",
    category_slug: "food_cafe",
    tags: [],
    spent_at: "2026-07-15T10:00:00.000Z",
    budget_impact: "regular"
  });
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient: capturingClient(calls)
  });

  await bot.handleUpdate(callbackUpdate("ee:x:91:back", 100));

  assert.equal(calls.some((call) => call.method === "editMessageText"), false);
  const message = calls.find((call) => call.method === "sendMessage");
  assert.ok(message);
  assert.match(message.text, /Записал|Saved/);
  assert.deepEqual(message.replyMarkup.inline_keyboard.map((row) => row.map((button) => button.callback_data ?? button.web_app?.url)), [
    ["ee:x:91:o", "ee:x:91:del"],
    ["http://localhost:3000?telegramUserId=100"]
  ]);
});

test("saved-expense text edit prepares rates before claiming the input session transaction", async () => {
  const calls = [];
  const order = [];
  const repo = fakeRepository();
  const expense = {
    id: 91,
    amount_original: 10,
    currency_original: "THB",
    amount_base: 10,
    description: "coffee",
    category_slug: "food_cafe",
    tags: [],
    spent_at: "2026-07-15T10:00:00.000Z",
    budget_impact: "regular"
  };
  repo.getRoutableTelegramInputSession = async () => ({
    id: 7, target_type: "expense", target_id: 91, item_index: null, field: "amount", chat_id: 10, message_id: 20
  });
  repo.getExpenseForTelegramUser = async () => expense;
  repo.prepareExpenseUpdateForTelegramUser = async (_id, _telegramUserId, patch) => {
    order.push("prepare");
    return { item: { ...expense, amount: patch.amount, currency: patch.currency }, moneyAmounts: { amountBase: patch.amount, convertedAmounts: {}, source: "test" } };
  };
  repo.consumeTelegramInputSession = async (_telegramUserId, { apply }) => {
    order.push("consume");
    await apply({ client: {} });
    return { outcome: "completed" };
  };
  repo.updateExpenseForTelegramUser = async (_id, _telegramUserId, _patch, _now, options) => {
    order.push("update");
    assert.ok(options.prepared);
    return { ...expense, amount_original: 20, amount_base: 20 };
  };
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient: capturingClient(calls)
  });

  await bot.handleUpdate(textUpdate("20", 100));

  assert.deepEqual(order, ["prepare", "consume", "update"]);
});

test("text edit removes prompt and stale editor before posting one fresh editor card", async () => {
  const calls = [];
  const repo = fakeRepository();
  const expense = {
    id: 91, amount_original: 10, currency_original: "THB", amount_base: 10,
    description: "coffee", category_slug: "food_cafe", tags: [],
    spent_at: "2026-07-15T10:00:00.000Z", budget_impact: "regular"
  };
  repo.getRoutableTelegramInputSession = async () => ({
    id: 7, target_type: "expense", target_id: 91, item_index: null, field: "amount",
    chat_id: 10, message_id: 20, prompt_message_id: 301
  });
  repo.getExpenseForTelegramUser = async () => expense;
  repo.prepareExpenseUpdateForTelegramUser = async () => null;
  repo.consumeTelegramInputSession = async (_telegramUserId, { apply }) => {
    await apply({ client: {} });
    return { outcome: "completed" };
  };
  repo.updateExpenseForTelegramUser = async () => ({ ...expense, amount_original: 20, amount_base: 20 });
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient: capturingClient(calls)
  });

  await bot.handleUpdate(textUpdate("20", 100));

  assert.deepEqual(calls.filter((call) => call.method === "deleteMessage").map((call) => call.messageId), [301, 20]);
  assert.equal(calls.some((call) => call.method === "editMessageText"), false);
  const fresh = calls.filter((call) => call.method === "sendMessage").at(-1);
  assert.ok(fresh?.replyMarkup?.inline_keyboard?.length);
});

test("description, date, and tags text edits each post one fresh editor card", async (t) => {
  for (const [field, text] of [["description", "lunch"], ["spent_at", "12 июля 2025 19:30"], ["tags", "work, lunch"]]) {
    await t.test(field, async () => {
      const calls = [];
      const repo = fakeRepository();
      repo.user = { ...repo.user, timezone: "Asia/Bangkok" };
      let item = {
        amount: 10, currency: "THB", description: "coffee", category_slug: "food_cafe", tags: [],
        spent_at: "2026-07-15T10:00:00.000Z", budget_impact: "regular"
      };
      repo.getRoutableTelegramInputSession = async () => ({
        id: 7, target_type: "draft", target_id: 42, item_index: 0, field,
        chat_id: 10, message_id: 20, prompt_message_id: 301
      });
      repo.getDraftForTelegramUser = async () => ({ id: 42, status: "pending", items: [item] });
      repo.consumeTelegramInputSession = async (_telegramUserId, { apply }) => {
        await apply({ client: {} });
        return { outcome: "completed" };
      };
      repo.updateDraftItemForTelegramUser = async (_draftId, _itemIndex, _telegramUserId, patch) => {
        item = { ...item, ...patch };
        return { id: 42, status: "pending", items: [item] };
      };
      const bot = createTelegramBot({
        token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo,
        telegramClient: capturingClient(calls), now: () => new Date("2026-07-15T12:00:00.000Z")
      });

      await bot.handleUpdate(textUpdate(text, 100));

      assert.deepEqual(calls.filter((call) => call.method === "deleteMessage").map((call) => call.messageId), [301, 20]);
      const fresh = calls.filter((call) => call.method === "sendMessage").at(-1);
      assert.ok(fresh?.replyMarkup?.inline_keyboard?.length);
    });
  }
});

test("starting every text field stores its prompt message reference", async () => {
  const calls = [];
  const repo = fakeRepository();
  const stored = [];
  const starts = [];
  repo.getExpenseForTelegramUser = async () => ({
    id: 91, amount_original: 10, currency_original: "THB", amount_base: 10, description: "coffee",
    category_slug: "food_cafe", tags: [], spent_at: "2026-07-15T10:00:00.000Z", budget_impact: "regular"
  });
  repo.startTelegramInputSession = async (_telegramUserId, input) => {
    starts.push(input);
    return {
      outcome: "started",
      session: { id: starts.length },
      replacedSession: starts.length > 1 ? { chat_id: 10, prompt_message_id: 300 + starts.length - 1 } : null
    };
  };
  repo.setTelegramInputSessionPrompt = async (...args) => { stored.push(args); return { outcome: "stored" }; };
  const telegramClient = capturingClient(calls);
  telegramClient.sendMessage = async (message) => {
    calls.push({ method: "sendMessage", ...message });
    return { ok: true, result: { message_id: 300 + starts.length } };
  };
  const bot = createTelegramBot({ token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient });

  for (const callbackData of ["ee:x:91:f:a", "ee:x:91:f:d", "ee:x:91:f:g", "ee:x:91:dt:c"]) {
    await bot.handleUpdate(callbackUpdate(callbackData, 100));
  }

  assert.deepEqual(starts.map((input) => input.field), ["amount", "description", "tags", "spent_at"]);
  assert.deepEqual(stored.map((args) => args[2].promptMessageId), [301, 302, 303, 304]);
  assert.deepEqual(stored.map((args) => args[0]), [100, 100, 100, 100]);
  assert.deepEqual(calls.filter((call) => call.method === "sendMessage").map((call) => call.replyMarkup.inline_keyboard[0][0].callback_data), [
    "ee:x:91:cancel:1", "ee:x:91:cancel:2", "ee:x:91:cancel:3", "ee:x:91:cancel:4"
  ]);
  assert.deepEqual(calls.filter((call) => call.method === "deleteMessage").map((call) => call.messageId), [301, 302, 303]);
});

test("text /cancel deactivates the active editor prompt", async () => {
  const calls = [];
  const repo = fakeRepository();
  const activeSession = {
    id: 7, target_type: "expense", target_id: 91, item_index: null, field: "amount",
    chat_id: 10, message_id: 20, prompt_message_id: 301
  };
  repo.getRoutableTelegramInputSession = async () => activeSession;
  repo.cancelTelegramInputSession = async () => ({ outcome: "cancelled", session: activeSession });
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient: capturingClient(calls)
  });

  await bot.handleUpdate(textUpdate("/cancel", 100));

  assert.deepEqual(calls.filter((call) => call.method === "deleteMessage").map((call) => call.messageId), [301]);
  assert.equal(repo.events.some((event) => event.eventName === "expense_draft_created"), false);
});

test("failed text-input prompt delivery closes the exact new session", async () => {
  const calls = [];
  const repo = fakeRepository();
  const closed = [];
  repo.getExpenseForTelegramUser = async () => ({
    id: 91, amount_original: 10, currency_original: "THB", amount_base: 10, description: "coffee",
    category_slug: "food_cafe", tags: [], spent_at: "2026-07-15T10:00:00.000Z", budget_impact: "regular"
  });
  repo.startTelegramInputSession = async () => ({ outcome: "started", session: { id: 7 } });
  repo.closeTelegramInputSessionForTarget = async (...args) => {
    closed.push(args);
    return { outcome: "cancelled", session: { chat_id: 10 } };
  };
  const telegramClient = capturingClient(calls);
  telegramClient.sendMessage = async () => { throw new Error("telegram unavailable"); };
  const bot = createTelegramBot({ token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient });

  await assert.doesNotReject(bot.handleUpdate(callbackUpdate("ee:x:91:f:a", 100)));

  assert.deepEqual(closed[0].slice(0, 2), [100, { targetType: "expense", targetId: 91, itemIndex: null, sessionId: 7 }]);
  assert.ok(calls.some((call) => call.method === "answerCallbackQuery"));
});

test("failed text-input prompt persistence removes the prompt and closes the exact session", async () => {
  const calls = [];
  const repo = fakeRepository();
  const closed = [];
  repo.getExpenseForTelegramUser = async () => ({
    id: 91, amount_original: 10, currency_original: "THB", amount_base: 10, description: "coffee",
    category_slug: "food_cafe", tags: [], spent_at: "2026-07-15T10:00:00.000Z", budget_impact: "regular"
  });
  repo.startTelegramInputSession = async () => ({ outcome: "started", session: { id: 7 } });
  repo.setTelegramInputSessionPrompt = async () => ({ outcome: "none" });
  repo.closeTelegramInputSessionForTarget = async (...args) => {
    closed.push(args);
    return { outcome: "cancelled", session: { chat_id: 10 } };
  };
  const telegramClient = capturingClient(calls);
  telegramClient.sendMessage = async (message) => {
    calls.push({ method: "sendMessage", ...message });
    return { ok: true, result: { message_id: 301 } };
  };
  const bot = createTelegramBot({ token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient });

  await assert.doesNotReject(bot.handleUpdate(callbackUpdate("ee:x:91:f:a", 100)));

  assert.deepEqual(closed[0].slice(0, 2), [100, { targetType: "expense", targetId: 91, itemIndex: null, sessionId: 7 }]);
  assert.deepEqual(calls.filter((call) => call.method === "deleteMessage").map((call) => call.messageId), [301]);
});

test("inline input Cancel closes only its target and restores a fresh editor card", async () => {
  const calls = [];
  const repo = fakeRepository();
  const closed = [];
  repo.getExpenseForTelegramUser = async () => ({
    id: 91, amount_original: 10, currency_original: "THB", amount_base: 10, description: "coffee",
    category_slug: "food_cafe", tags: [], spent_at: "2026-07-15T10:00:00.000Z", budget_impact: "regular"
  });
  repo.closeTelegramInputSessionForTarget = async (...args) => {
    closed.push(args);
    return { outcome: "cancelled", session: { chat_id: 10, message_id: 20, prompt_message_id: 301 } };
  };
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient: capturingClient(calls)
  });

  await bot.handleUpdate(callbackUpdate("ee:x:91:cancel:7", 100));

  assert.equal(closed.length, 1);
  assert.deepEqual(closed[0].slice(0, 2), [100, { targetType: "expense", targetId: 91, itemIndex: null, sessionId: 7 }]);
  assert.deepEqual(calls.filter((call) => call.method === "deleteMessage").map((call) => call.messageId), [301, 20]);
  assert.equal(calls.some((call) => call.method === "editMessageText"), false);
  assert.ok(calls.some((call) => call.method === "sendMessage" && call.replyMarkup?.inline_keyboard));
});

test("stale inline Cancel cannot close a newer session for the same target", async () => {
  const calls = [];
  const repo = fakeRepository();
  const closed = [];
  repo.getExpenseForTelegramUser = async () => ({
    id: 91, amount_original: 10, currency_original: "THB", amount_base: 10, description: "coffee",
    category_slug: "food_cafe", tags: [], spent_at: "2026-07-15T10:00:00.000Z", budget_impact: "regular"
  });
  repo.closeTelegramInputSessionForTarget = async (...args) => {
    closed.push(args);
    return { outcome: "none" };
  };
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient: capturingClient(calls)
  });

  await bot.handleUpdate(callbackUpdate("ee:x:91:cancel:7", 100));

  assert.deepEqual(closed[0].slice(0, 2), [100, { targetType: "expense", targetId: 91, itemIndex: null, sessionId: 7 }]);
  assert.equal(calls.some((call) => call.method === "deleteMessage"), false);
  assert.ok(calls.some((call) => call.method === "answerCallbackQuery"));
});

test("inline Cancel closes a session even after its target has disappeared", async () => {
  const calls = [];
  const repo = fakeRepository();
  const closed = [];
  repo.getExpenseForTelegramUser = async () => null;
  repo.closeTelegramInputSessionForTarget = async (...args) => {
    closed.push(args);
    return { outcome: "cancelled", session: { chat_id: 10, prompt_message_id: 301 } };
  };
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient: capturingClient(calls)
  });

  await bot.handleUpdate(callbackUpdate("ee:x:91:cancel:7", 100));

  assert.deepEqual(closed[0].slice(0, 2), [100, { targetType: "expense", targetId: 91, itemIndex: null, sessionId: 7 }]);
  assert.deepEqual(calls.filter((call) => call.method === "deleteMessage").map((call) => call.messageId), [301]);
  assert.ok(calls.some((call) => call.method === "answerCallbackQuery"));
});

test("plain text after inline input Cancel reaches the normal expense parser", async () => {
  const calls = [];
  const repo = fakeRepository();
  let active = true;
  repo.getExpenseForTelegramUser = async () => ({
    id: 91, amount_original: 10, currency_original: "THB", amount_base: 10, description: "coffee",
    category_slug: "food_cafe", tags: [], spent_at: "2026-07-15T10:00:00.000Z", budget_impact: "regular"
  });
  repo.getRoutableTelegramInputSession = async () => active ? {
    id: 7, target_type: "expense", target_id: 91, item_index: null, field: "amount", chat_id: 10, message_id: 20, prompt_message_id: 301
  } : null;
  repo.closeTelegramInputSessionForTarget = async () => {
    active = false;
    return { outcome: "cancelled", session: { chat_id: 10, message_id: 20, prompt_message_id: 301 } };
  };
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient: capturingClient(calls)
  });

  await bot.handleUpdate(callbackUpdate("ee:x:91:cancel:7", 100));
  await bot.handleUpdate(textUpdate("coffee 20", 100));

  assert.ok(repo.events.some((event) => event.eventName === "expense_draft_created"));
});

test("date session cancelled from the draft card closes before a normal expense is parsed", async () => {
  const calls = [];
  const repo = fakeRepository();
  const closed = [];
  let active = true;
  repo.getRoutableTelegramInputSession = async () => active ? {
    id: 7, target_type: "draft", target_id: 42, item_index: 0, field: "spent_at", chat_id: 10, message_id: 20, prompt_message_id: 301
  } : null;
  repo.closeTelegramInputSessionForTarget = async (...args) => {
    closed.push(args);
    active = false;
    return { outcome: "cancelled", session: { chat_id: 10, prompt_message_id: 301 } };
  };
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient: capturingClient(calls)
  });

  await bot.handleUpdate(callbackUpdate("d:42:cancel", 100));
  await bot.handleUpdate(textUpdate("coffee 20", 100));

  assert.deepEqual(closed[0].slice(0, 2), [100, { targetType: "draft", targetId: 42, itemIndex: undefined }]);
  assert.deepEqual(calls.filter((call) => call.method === "deleteMessage").map((call) => call.messageId), [301]);
  assert.ok(repo.events.some((event) => event.eventName === "expense_draft_created"));
});

test("saved expense deletion closes its matching active editor input session", async () => {
  const calls = [];
  const repo = fakeRepository();
  const closed = [];
  repo.getExpenseForTelegramUser = async () => ({
    id: 91, amount_original: 10, currency_original: "THB", amount_base: 10, description: "coffee",
    category_slug: "food_cafe", tags: [], spent_at: "2026-07-15T10:00:00.000Z", budget_impact: "regular"
  });
  repo.deleteExpenseForTelegramUser = async () => ({ id: 91 });
  repo.closeTelegramInputSessionForTarget = async (...args) => {
    closed.push(args);
    return { outcome: "cancelled", session: { chat_id: 10, prompt_message_id: 301 } };
  };
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient: capturingClient(calls)
  });

  await bot.handleUpdate(callbackUpdate("ee:x:91:delok", 100));

  assert.deepEqual(closed[0].slice(0, 2), [100, { targetType: "expense", targetId: 91, itemIndex: null }]);
  assert.deepEqual(calls.filter((call) => call.method === "deleteMessage").map((call) => call.messageId), [301]);
});

test("export callback sends CSV document through Telegram", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.user = { ...repo.user, interface_language: "en" };
  repo.listExpenseExportRowsForTelegramUser = async (_telegramUserId, options = {}) => {
    if (options.offset > 0) return [];
    return [{
      spent_at: new Date("2026-07-02T08:00:00Z"),
      amount_original: "70.50",
      currency_original: "THB",
      display: { amount: 70.5, currency: "THB" },
      category_slug: "food_cafe",
      description: "coffee, milk",
      created_at: new Date("2026-07-02T08:01:00Z")
    }];
  };
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: capturingClient(calls),
    now: () => new Date("2026-07-08T10:00:00Z")
  });

  await bot.handleUpdate({
    callback_query: {
      id: "callback-export-month",
      data: "export:month",
      from: { id: 100 },
      message: { chat: { id: 10 }, message_id: 55 }
    }
  });

  const document = calls.find((call) => call.method === "sendDocument");
  assert.ok(document);
  assert.equal(document.chatId, 10);
  assert.equal(document.filename, "money-flow-export-2026-07.csv");
  assert.equal(document.contentType, "text/csv; charset=utf-8");
  assert.match(document.content.toString("utf8"), /^﻿date,amount,currency,amount_display,display_currency,category,note,type,created_at/);
  assert.match(document.content.toString("utf8"), /"coffee, milk",expense/);
  assert.ok(calls.some((call) => call.method === "answerCallbackQuery" && /Preparing export/i.test(call.text)));
});

test("empty export callback sends message without creating CSV document", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.user = { ...repo.user, interface_language: "en" };
  repo.listExpenseExportRowsForTelegramUser = async () => [];
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: capturingClient(calls)
  });

  await bot.handleUpdate({
    callback_query: {
      id: "callback-export-empty",
      data: "export:all",
      from: { id: 100 },
      message: { chat: { id: 10 }, message_id: 55 }
    }
  });

  assert.equal(calls.some((call) => call.method === "sendDocument"), false);
  const message = calls.find((call) => call.method === "sendMessage");
  assert.ok(message);
  assert.match(message.text, /No expenses/i);
});

test("text message never calls voice transcription", async () => {
  let transcribeCalled = false;
  const originalLog = console.log;
  console.log = () => {};
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: fakeRepository(),
      perfLogger: () => {},
      voiceTranscriber: {
        isConfigured: () => true,
        async transcribeTelegramVoice() {
          transcribeCalled = true;
          throw new Error("text message must not be transcribed");
        }
      }
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        text: "coffee 70 baht",
        voice: { file_id: "voice-file-id", mime_type: "audio/ogg" }
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(transcribeCalled, false);
});

test("message handling writes performance stage logs and compact summary", async () => {
  const perfLines = [];
  const originalLog = console.log;
  console.log = () => {};
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: fakeRepository(),
      perfLogger: (line) => perfLines.push(line),
      expenseParser: {
        model: "test-model",
        async parse() {
          return {
            expenses: [{
              amount: 70,
              currency: "THB",
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
        from: { id: 987654321, first_name: "M" },
        text: "coffee 70 baht"
      }
    });
  } finally {
    console.log = originalLog;
  }

  const stageLines = perfLines.filter((line) => line.startsWith("[perf:stage]"));
  const stages = stageLines.map((line) => line.match(/stage=([^ ]+)/)?.[1]);
  assert.ok(stages.includes("message_received"));
  assert.ok(stages.includes("user_context_start"));
  assert.ok(stages.includes("user_context_end"));
  assert.ok(stages.includes("llm_parse_start"));
  assert.ok(stages.includes("llm_parse_end"));
  assert.ok(stages.includes("db_save_start"));
  assert.ok(stages.includes("db_save_end"));
  assert.ok(stages.includes("telegram_response_start"));
  assert.ok(stages.includes("telegram_response_end"));
  assert.ok(stages.includes("total_done"));
  assert.ok(stageLines.every((line) => /traceId=[^ ]+/.test(line)));
  assert.ok(stageLines.every((line) => !/userId=/.test(line)));
  assert.doesNotMatch(perfLines.join("\n"), /987654321/);
  assert.ok(stageLines.every((line) => /messageType=text/.test(line)));
  assert.ok(stageLines.every((line) => /durationMs=\d+/.test(line)));
  assert.ok(stageLines.every((line) => /totalMs=\d+/.test(line)));
  assert.ok(stageLines.every((line) => /success=(true|false)/.test(line)));
  assert.ok(stages.every((stage) => !String(stage).startsWith("transcription")));
  assert.ok(stages.every((stage) => !String(stage).startsWith("telegram_file_download")));

  const summary = perfLines.find((line) => line.startsWith("[perf]"));
  assert.ok(summary);
  assert.match(summary, /traceId=[^ ]+ type=text total=\d+ms/);
  assert.match(summary, /llm=\d+ms/);
  assert.match(summary, /db=\d+ms/);
  assert.match(summary, /telegram=\d+ms/);
  assert.doesNotMatch(summary, /coffee 70 baht/);
});

test("voice message performance summary includes download and transcription stages", async () => {
  const perfLines = [];
  const originalLog = console.log;
  console.log = () => {};
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: fakeRepository(),
      perfLogger: (line) => perfLines.push(line),
      voiceTranscriber: {
        isConfigured: () => true,
        async transcribeTelegramVoice(_voice, options = {}) {
          options.onPerfStage("telegram_file_download_start", { audioDurationSec: 3 });
          options.onPerfStage("telegram_file_download_end", { audioDurationSec: 3, fileSizeKb: 12 });
          options.onPerfStage("transcription_start", { transcriptionProvider: "deepgram" });
          options.onPerfStage("transcription_end", { transcriptionProvider: "deepgram", responseChars: 11 });
          return "coffee 70 baht";
        }
      }
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        voice: { file_id: "voice-file-id", mime_type: "audio/ogg", duration: 3 }
      }
    });
  } finally {
    console.log = originalLog;
  }

  const stageLines = perfLines.filter((line) => line.startsWith("[perf:stage]"));
  assert.ok(stageLines.some((line) => /stage=telegram_file_download_start/.test(line)));
  assert.ok(stageLines.some((line) => /stage=telegram_file_download_end/.test(line) && /fileSizeKb=12/.test(line)));
  assert.ok(stageLines.some((line) => /stage=transcription_start/.test(line) && /transcriptionProvider=deepgram/.test(line)));
  assert.ok(stageLines.some((line) => /stage=transcription_end/.test(line) && /responseChars=11/.test(line)));

  const summary = perfLines.find((line) => line.startsWith("[perf]"));
  assert.ok(summary);
  assert.match(summary, /type=voice/);
  assert.match(summary, /download=\d+ms/);
  assert.match(summary, /transcription=\d+ms/);
  assert.match(summary, /llm=\d+ms/);
  assert.match(summary, /db=\d+ms/);
  assert.match(summary, /telegram=\d+ms/);
});

test("completed text message app event includes parser metadata", async () => {
  const repo = fakeRepository();
  const originalLog = console.log;
  console.log = () => {};
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      expenseParser: {
        model: "local-parser",
        async parse(_text, options = {}) {
          options.onLlmTrace({
            parserEngine: "local-fast-path",
            parserRoute: "local_primary",
            localFastPathAccepted: true,
            localFastPathRejectReason: null,
            categoryResolution: "resolved",
            localAcceptanceLevel: "local_safe",
            localCandidate: true,
            llmSkipped: true,
            fastPathMode: "enabled",
            shadowDisagreement: null,
            criticalShadowDisagreement: null,
            categoryOnlyShadowDisagreement: null,
            shadowDisagreementFields: [],
            localParseMs: 2,
            localEvaluateMs: 1,
            parserTotalMs: 4,
            model: "local-parser",
            promptChars: 9,
            responseChars: 220
          });
          return {
            expenses: [{
              amount: 80,
              currency: "THB",
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
        text: "coffee 80"
      }
    });
  } finally {
    console.log = originalLog;
  }

  const completed = repo.events.find((event) => event.eventName === "message_processing_completed");
  assert.ok(completed);
  assert.equal(completed.metadata.inputType, "text");
  assert.equal(completed.metadata.parserEngine, "local-fast-path");
  assert.equal(completed.metadata.parserRoute, "local_primary");
  assert.equal(completed.metadata.localFastPathAccepted, true);
  assert.equal(completed.metadata.localAcceptanceLevel, "local_safe");
  assert.equal(completed.metadata.localCandidate, true);
  assert.equal(completed.metadata.llmSkipped, true);
  assert.equal(completed.metadata.fastPathMode, "enabled");
  assert.equal(completed.metadata.categoryResolution, "resolved");
  assert.equal(completed.metadata.localParseMs, 2);
  assert.equal(completed.metadata.localEvaluateMs, 1);
  assert.equal(completed.metadata.parserTotalMs, 4);
  assert.equal(Number.isFinite(completed.metadata.processingTotalMs), true);
});

test("completed voice message app event includes parser metadata and transcript size", async () => {
  const repo = fakeRepository();
  const originalLog = console.log;
  console.log = () => {};
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      voiceTranscriber: {
        isConfigured: () => true,
        async transcribeTelegramVoice(_voice, options = {}) {
          options.onPerfStage("telegram_file_download_start", { audioDurationSec: 3 });
          options.onPerfStage("telegram_file_download_end", { audioDurationSec: 3, fileSizeKb: 12 });
          options.onPerfStage("transcription_start", { transcriptionProvider: "deepgram" });
          options.onPerfStage("transcription_end", { transcriptionProvider: "deepgram", responseChars: 9 });
          return "coffee 80";
        }
      },
      expenseParser: {
        model: "local-parser",
        async parse(_text, options = {}) {
          options.onLlmTrace({
            parserEngine: "local-fast-path",
            parserRoute: "local_primary",
            localFastPathAccepted: true,
            localFastPathRejectReason: null,
            categoryResolution: "resolved",
            localAcceptanceLevel: "local_safe",
            localCandidate: true,
            llmSkipped: true,
            fastPathMode: "enabled",
            shadowDisagreement: null,
            criticalShadowDisagreement: null,
            categoryOnlyShadowDisagreement: null,
            shadowDisagreementFields: [],
            localParseMs: 3,
            localEvaluateMs: 1,
            parserTotalMs: 5,
            model: "local-parser",
            promptChars: 9,
            responseChars: 220
          });
          return {
            expenses: [{
              amount: 80,
              currency: "THB",
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
        voice: { file_id: "voice-file-id", mime_type: "audio/ogg", duration: 3 }
      }
    });
  } finally {
    console.log = originalLog;
  }

  const completed = repo.events.find((event) => event.eventName === "message_processing_completed");
  assert.ok(completed);
  assert.equal(completed.metadata.inputType, "voice");
  assert.equal(completed.metadata.parserEngine, "local-fast-path");
  assert.equal(completed.metadata.parserRoute, "local_primary");
  assert.equal(completed.metadata.localAcceptanceLevel, "local_safe");
  assert.equal(completed.metadata.localCandidate, true);
  assert.equal(completed.metadata.localParseMs, 3);
  assert.equal(completed.metadata.localEvaluateMs, 1);
  assert.equal(completed.metadata.parserTotalMs, 5);
  assert.equal(completed.metadata.llmSkipped, true);
  assert.equal(completed.metadata.transcriptChars, 9);
});

test("enabled fast-path creates voice draft metadata without OpenAI call", async () => {
  const repo = fakeRepository();
  let openAiCalls = 0;
  let createdDraft = null;
  repo.createDraft = async (userId, sourceText, items) => {
    createdDraft = { userId, sourceText, items };
    return { id: 42 };
  };
  const originalLog = console.log;
  console.log = () => {};
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      voiceTranscriber: {
        isConfigured: () => true,
        async transcribeTelegramVoice() {
          return "coffee 80";
        }
      },
      expenseParser: createExpenseParser({
        apiKey: "test-key",
        fastPathMode: "enabled",
        localFirstUserIds: ["100"],
        parserTextHashSecret: "test-secret",
        now: () => new Date("2026-06-02T10:00:00+07:00"),
        fetchImpl: async () => {
          openAiCalls += 1;
          throw new Error("OpenAI should not be called");
        }
      })
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        voice: { file_id: "voice-file-id", mime_type: "audio/ogg", duration: 3 }
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(openAiCalls, 0);
  assert.equal(createdDraft.sourceText, "coffee 80");
  assert.equal(createdDraft.items[0].amount, 80);
  const completed = repo.events.find((event) => event.eventName === "message_processing_completed");
  assert.equal(completed.metadata.parserEngine, "local-fast-path");
  assert.equal(completed.metadata.llmSkipped, true);
  assert.equal(completed.metadata.fastPathMode, "enabled");
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
    assert.deepEqual(repo.events.filter((event) => event.eventName !== "draft_confirm_processing_completed"), [
      { userId: 1, eventName: "expense_draft_confirmed", metadata: { draftType: "regular" } },
      { userId: 1, eventName: "expense_saved", metadata: { draftType: "regular" } }
    ]);
    assert.match(calls[0][1].text, /Записал/);
    assert.match(calls[0][1].text, /<b>Сегодня<\/b>/);
    assert.match(calls[0][1].text, /<b>Месяц<\/b>/);
    assert.match(calls[0][1].text.replaceAll("\u00a0", " "), /Потрачено:<\/b> 735 THB \/ 42 000 THB/);
    assert.match(calls[0][1].text, /1,75%/);
    assert.doesNotMatch(calls[0][1].text, /Плановые сегодня|Крупные сегодня|Всего за день/);
  } finally {
    console.log = originalLog;
  }
});

test("legacy Telegram confirmation uses explicit acceptance for review and multi-item drafts", async () => {
  const repo = fakeRepository();
  let explicitDraftId = null;
  repo.confirmDraftWithExplicitAcceptance = async (draftId) => {
    explicitDraftId = draftId;
    return {
      expenses: [
        { id: 71, amount_base: 75, amount_original: 75, currency_original: "THB", category_slug: "food_cafe", description: "breakfast" },
        { id: 72, amount_base: 125, amount_original: 125, currency_original: "THB", category_slug: "other", description: "shop" }
      ],
      dashboardSnapshot: null,
      alreadySaved: false
    };
  };
  const calls = [];
  const bot = createTelegramBot({ token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient: capturingClient(calls) });

  await bot.handleUpdate({ callback_query: {
    id: "callback-explicit-review", data: "confirm:42", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 55 }
  } });

  assert.equal(explicitDraftId, "42");
  assert.ok(calls.some((call) => call.method === "editMessageText"));
  assert.equal(repo.events.filter((event) => event.eventName === "expense_saved").length, 2);
});

test("closed-month Telegram confirmation explains the block and leaves the old keyboard active", async () => {
  const repo = fakeRepository();
  repo.confirmDraftWithExplicitAcceptance = async () => {
    throw Object.assign(new Error("closed"), { code: "expense_source_month_closed" });
  };
  const calls = [];
  const bot = createTelegramBot({ token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient: capturingClient(calls) });

  await assert.doesNotReject(() => bot.handleUpdate({ callback_query: {
    id: "callback-closed-month", data: "confirm:42", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 55 }
  } }));

  assert.equal(calls.some((call) => call.method === "editMessageText"), false);
  assert.ok(calls.some((call) => call.method === "sendMessage" && /месяц уже закрыт/i.test(call.text)));
});

test("regular draft confirmation acknowledges before saving, delivers before background work, and records safe diagnostics", async () => {
  const order = [];
  const repo = fakeRepository();
  repo.saveDraftAsExpense = async () => {
    order.push("save");
    return { expenses: [{ id: 71, amount_base: 75 }], dashboardSnapshot: null, alreadySaved: false };
  };
  repo.closeTelegramInputSessionForTarget = async () => {
    order.push("cleanup");
    return { outcome: "closed", session: null };
  };
  repo.recordAppEvent = async (userId, eventName, metadata) => {
    order.push(eventName === "draft_confirm_processing_completed" ? "diagnostic" : `event:${eventName}`);
    repo.events.push({ userId, eventName, metadata });
  };
  const calls = [];
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: {
      async answerCallbackQuery(message) { order.push("ack"); calls.push({ method: "answerCallbackQuery", ...message }); return { ok: true }; },
      async editMessageText(message) { order.push("terminal"); calls.push({ method: "editMessageText", ...message }); return { ok: true }; },
      async sendMessage(message) { order.push("terminal"); calls.push({ method: "sendMessage", ...message }); return { ok: true }; },
      async deleteMessage() { return { ok: true }; }
    }
  });

  await bot.handleUpdate({ callback_query: {
    id: "callback-latency", data: "confirm:42", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 55 }
  } });

  assert.equal(calls.filter((call) => call.method === "answerCallbackQuery").length, 1);
  assert.equal(calls[0].text, "Сохраняю…");
  assert.ok(order.indexOf("ack") < order.indexOf("save"));
  assert.ok(order.indexOf("terminal") < order.indexOf("event:expense_draft_confirmed"));
  assert.ok(order.indexOf("terminal") < order.indexOf("cleanup"));
  assert.ok(order.indexOf("diagnostic") > order.indexOf("cleanup"));
  const diagnostic = repo.events.find((event) => event.eventName === "draft_confirm_processing_completed");
  assert.equal(diagnostic.userId, null);
  assert.deepEqual(Object.keys(diagnostic.metadata).sort(), [
    "callbackAckMs", "callbackAckSucceeded", "cleanupMs", "dbSaveMs", "expenseCount", "outcome",
    "source", "summaryBuildMs", "telegramUpdateMode", "telegramUpdateMs", "telegramUpdateSucceeded", "totalMs", "userResultMs"
  ]);
  assert.equal(diagnostic.metadata.outcome, "success");
  assert.equal(diagnostic.metadata.expenseCount, 1);
});

test("regular draft confirmation preserves the card for retryable persistence failures", async () => {
  for (const error of [new CategoryRequiredError(), new Error("database unavailable")]) {
    const repo = fakeRepository();
    repo.saveDraftAsExpense = async () => { throw error; };
    let closed = 0;
    repo.closeTelegramInputSessionForTarget = async () => { closed += 1; return { outcome: "closed" }; };
    const calls = [];
    const bot = createTelegramBot({ token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient: capturingClient(calls) });

    await assert.doesNotReject(() => bot.handleUpdate({ callback_query: {
      id: `callback-${error.name}`, data: "d:42:confirm", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 55 }
    } }));

    assert.equal(calls.filter((call) => call.method === "answerCallbackQuery").length, 1);
    assert.equal(calls.some((call) => call.method === "editMessageText"), false);
    assert.equal(closed, 0);
    assert.equal(calls.filter((call) => call.method === "sendMessage").length, 1);
  }
});

test("unexpected draft confirmation persistence failures notify admins with safe context", async () => {
  const repo = fakeRepository();
  repo.saveDraftAsExpense = async () => { throw new Error("database unavailable"); };
  const alerts = [];
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: capturingClient([]),
    adminAlertService: {
      async notifyAdminError(error, context) {
        alerts.push({ error, context });
      }
    }
  });

  await assert.doesNotReject(() => bot.handleUpdate({ callback_query: {
    id: "callback-persistence-alert", data: "confirm:42", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 55 }
  } }));

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].error.message, "database unavailable");
  assert.deepEqual(alerts[0].context, { source: "telegram", route: "telegram_confirm", stage: "db_save", userId: 1 });
});

test("cancelled and category-required confirmations do not notify admins", async () => {
  for (const error of [new DraftCanceledError(), new CategoryRequiredError()]) {
    const repo = fakeRepository();
    repo.saveDraftAsExpense = async () => { throw error; };
    const alerts = [];
    const bot = createTelegramBot({
      token: "test-token",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      telegramClient: capturingClient([]),
      adminAlertService: { async notifyAdminError(...args) { alerts.push(args); } }
    });

    await assert.doesNotReject(() => bot.handleUpdate({ callback_query: {
      id: `callback-no-alert-${error.name}`, data: "confirm:42", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 55 }
    } }));

    assert.deepEqual(alerts, []);
  }
});

test("a terminal confirmation delivery failure after commit notifies admins", async () => {
  const repo = fakeRepository();
  repo.saveDraftAsExpense = async () => ({
    expenses: [{ id: 71, amount_base: 75 }], dashboardSnapshot: null, alreadySaved: false
  });
  const alerts = [];
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: {
      async answerCallbackQuery() { return { ok: true }; },
      async editMessageText() { throw new Error("edit unavailable"); },
      async sendMessage() { throw new Error("send unavailable"); },
      async deleteMessage() { return { ok: true }; }
    },
    adminAlertService: {
      async notifyAdminError(error, context) {
        alerts.push({ error, context });
      }
    }
  });

  await assert.doesNotReject(() => bot.handleUpdate({ callback_query: {
    id: "callback-delivery-alert", data: "confirm:42", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 55 }
  } }));

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].error.message, "send unavailable");
  assert.deepEqual(alerts[0].context, { source: "telegram", route: "telegram_confirm", stage: "telegram_update", userId: 1 });
});

test("a failed confirm admin alert does not break the user flow", async () => {
  const repo = fakeRepository();
  repo.saveDraftAsExpense = async () => { throw new Error("database unavailable"); };
  const calls = [];
  let alertAttempts = 0;
  const originalError = console.error;
  console.error = () => {};
  try {
    const bot = createTelegramBot({
      token: "test-token",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      telegramClient: capturingClient(calls),
      adminAlertService: {
        async notifyAdminError() {
          alertAttempts += 1;
          throw new Error("admin Telegram unavailable");
        }
      }
    });

    await assert.doesNotReject(() => bot.handleUpdate({ callback_query: {
      id: "callback-alert-failure", data: "confirm:42", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 55 }
    } }));
  } finally {
    console.error = originalError;
  }

  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 1);
  assert.equal(alertAttempts, 1);
});

test("regular draft cancellation gets one early acknowledgement and terminalizes its card", async () => {
  const repo = fakeRepository();
  repo.saveDraftAsExpense = async () => { throw new DraftCanceledError(); };
  const calls = [];
  const bot = createTelegramBot({ token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient: capturingClient(calls) });

  await bot.handleUpdate({ callback_query: {
    id: "callback-cancelled-confirm", data: "confirm:42", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 55 }
  } });

  assert.equal(calls.filter((call) => call.method === "answerCallbackQuery").length, 1);
  assert.ok(calls.some((call) => call.method === "editMessageText" && /Черновик отменён|Draft canceled/.test(call.text)));
});

test("a failed early acknowledgement and terminal delivery do not change a committed confirmation outcome", async () => {
  const repo = fakeRepository();
  let saveCalls = 0;
  repo.saveDraftAsExpense = async () => {
    saveCalls += 1;
    return { expenses: [{ id: 71, amount_base: 75 }], dashboardSnapshot: null, alreadySaved: false };
  };
  const diagnosticEvents = [];
  repo.recordAppEvent = async (userId, eventName, metadata) => {
    if (eventName === "draft_confirm_processing_completed") diagnosticEvents.push({ userId, metadata });
  };
  const calls = [];
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo,
    telegramClient: {
      async answerCallbackQuery(message) { calls.push({ method: "answerCallbackQuery", ...message }); throw new Error("ack unavailable"); },
      async editMessageText(message) { calls.push({ method: "editMessageText", ...message }); throw new Error("edit unavailable"); },
      async editMessageReplyMarkup() { throw new Error("markup unavailable"); },
      async sendMessage(message) { calls.push({ method: "sendMessage", ...message }); throw new Error("send unavailable"); },
      async deleteMessage() { return { ok: true }; }
    }
  });

  await assert.doesNotReject(() => bot.handleUpdate({ callback_query: {
    id: "callback-delivery-failed", data: "confirm:42", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 55 }
  } }));

  assert.equal(saveCalls, 1);
  assert.equal(calls.filter((call) => call.method === "answerCallbackQuery").length, 1);
  assert.equal(diagnosticEvents.length, 1);
  assert.equal(diagnosticEvents[0].userId, null);
  assert.equal(diagnosticEvents[0].metadata.outcome, "success");
  assert.equal(diagnosticEvents[0].metadata.callbackAckSucceeded, false);
  assert.equal(diagnosticEvents[0].metadata.telegramUpdateMode, "failed");
  assert.equal(diagnosticEvents[0].metadata.telegramUpdateSucceeded, false);
});

test("failed edit and fallback send leave the original draft card active", async () => {
  const repo = fakeRepository();
  repo.saveDraftAsExpense = async () => ({
    expenses: [{ id: 71, amount_base: 75 }], dashboardSnapshot: null, alreadySaved: false
  });
  const calls = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    const bot = createTelegramBot({
      token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo,
      telegramClient: {
        async answerCallbackQuery(message) { calls.push({ method: "answerCallbackQuery", ...message }); return { ok: true }; },
        async editMessageText(message) { calls.push({ method: "editMessageText", ...message }); throw new Error("edit unavailable"); },
        async sendMessage(message) { calls.push({ method: "sendMessage", ...message }); throw new Error("send unavailable"); },
        async editMessageReplyMarkup(message) { calls.push({ method: "editMessageReplyMarkup", ...message }); return { ok: true }; },
        async deleteMessage() { return { ok: true }; }
      }
    });
    await assert.doesNotReject(() => bot.handleUpdate({ callback_query: {
      id: "callback-card-kept", data: "confirm:42", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 55 }
    } }));
  } finally {
    console.error = originalError;
  }

  assert.ok(calls.some((call) => call.method === "editMessageText"));
  assert.ok(calls.some((call) => call.method === "sendMessage"));
  assert.equal(calls.some((call) => call.method === "editMessageReplyMarkup"), false);
});

test("category-required confirmation leaves the card and editor session available for a successful retry", async () => {
  const repo = fakeRepository();
  let attempts = 0;
  let closed = 0;
  repo.saveDraftAsExpense = async () => {
    attempts += 1;
    if (attempts === 1) throw new CategoryRequiredError();
    return { expenses: [{ id: 71, amount_base: 75 }], dashboardSnapshot: null, alreadySaved: false };
  };
  repo.closeTelegramInputSessionForTarget = async () => {
    closed += 1;
    return { outcome: "closed", session: null };
  };
  const calls = [];
  const bot = createTelegramBot({ token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient: capturingClient(calls) });
  const update = { callback_query: {
    id: "callback-category-retry", data: "confirm:42", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 55 }
  } };

  await bot.handleUpdate(update);
  assert.equal(calls.some((call) => call.method === "editMessageText"), false);
  assert.equal(closed, 0);
  await bot.handleUpdate(update);

  assert.equal(attempts, 2);
  assert.equal(closed, 1);
  assert.ok(calls.some((call) => call.method === "editMessageText"));
  assert.equal(calls.filter((call) => call.method === "answerCallbackQuery").length, 2);
});

test("parser-provided other cannot emit a saved event before explicit category selection", async () => {
  const repo = fakeRepository();
  repo.saveDraftAsExpense = async () => { throw new CategoryRequiredError(); };
  const calls = [];
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: capturingClient(calls)
  });

  await bot.handleUpdate({ callback_query: {
    id: "callback-parser-other",
    data: "d:42:confirm",
    from: { id: 100 },
    message: { chat: { id: 10 }, message_id: 55 }
  } });

  assert.equal(repo.events.some((event) => event.eventName === "expense_draft_confirmed"), false);
  assert.equal(calls.some((call) => call.method === "editMessageText"), false);
  assert.ok(calls.some((call) => call.method === "sendMessage" && /категор|categor/i.test(call.text)));
});

test("confirmation absorbs analytics, cleanup, and diagnostic failures without unhandled rejections", async () => {
  const repo = fakeRepository();
  repo.saveDraftAsExpense = async () => ({
    expenses: [{ id: 71, amount_base: 75 }, { id: 72, amount_base: 125 }], dashboardSnapshot: null, alreadySaved: false
  });
  let eventAttempts = 0;
  repo.recordAppEvent = async () => {
    eventAttempts += 1;
    throw new Error("event store unavailable");
  };
  repo.closeTelegramInputSessionForTarget = async () => { throw new Error("cleanup unavailable"); };
  const calls = [];
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    const bot = createTelegramBot({ token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient: capturingClient(calls) });
    await assert.doesNotReject(() => bot.handleUpdate({ callback_query: {
      id: "callback-background-failures", data: "confirm:42", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 55 }
    } }));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
    process.off("unhandledRejection", onUnhandled);
  }

  assert.ok(calls.some((call) => call.method === "editMessageText"));
  assert.equal(eventAttempts, 4);
  assert.deepEqual(unhandled, []);
});

test("confirm callback edits the original draft message into saved summary with expense actions", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.saveDraftAsExpense = async () => ({
    expenses: [{ id: 1, amount_base: 75 }],
    dashboardSnapshot: null,
    alreadySaved: false
  });
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: {
      async sendMessage(message) {
        calls.push({ method: "sendMessage", ...message });
        return { ok: true };
      },
      async editMessageText(message) {
        calls.push({ method: "editMessageText", ...message });
        return { ok: true };
      },
      async answerCallbackQuery(message) {
        calls.push({ method: "answerCallbackQuery", ...message });
        return { ok: true };
      },
      async deleteMessage(message) {
        calls.push({ method: "deleteMessage", ...message });
        return { ok: true };
      }
    }
  });

  await bot.handleUpdate({
    callback_query: {
      id: "callback-confirm-edit",
      data: "confirm:42",
      from: { id: 100 },
      message: { chat: { id: 10 }, message_id: 55 }
    }
  });

  const edit = calls.find((call) => call.method === "editMessageText");
  assert.ok(edit);
  assert.equal(edit.chatId, 10);
  assert.equal(edit.messageId, 55);
  assert.match(edit.text, /Записал|Saved/);
  assert.deepEqual(edit.replyMarkup.inline_keyboard.map((row) => row.map((button) => button.callback_data ?? button.web_app?.url)), [
    ["ee:x:1:o", "ee:x:1:del"],
    ["http://localhost:3000?telegramUserId=100"]
  ]);
  const answer = calls.find((call) => call.method === "answerCallbackQuery");
  assert.equal(answer?.text, "Сохраняю…");
  assert.equal(calls.some((call) => call.method === "sendMessage" && /Записал|Saved/.test(call.text)), false);
});

test("voice message is transcribed and saves a confident expense", async () => {
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

    assert.match(calls[0][1].text, /Заношу расход|Adding expense/);
    assert.match(calls[1][1].text, /Записал/);
    assert.match(calls[1][1].text, /70 THB/);
    assert.match(calls[1][1].replyMarkup.inline_keyboard[0][0].callback_data, /^ee:x:/);
  } finally {
    console.log = originalLog;
  }
});

test("cancel callback records a draft cancellation event", async () => {
  const repo = fakeRepository();
  const messages = [];
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate({
    callback_query: {
      id: "callback-cancel",
      data: "cancel:42",
      from: { id: 100 },
      message: { chat: { id: 10 }, message_id: 5 }
    }
  });

  assert.deepEqual(repo.events, [
    { userId: 1, eventName: "expense_draft_cancelled", metadata: { draftType: "regular" } }
  ]);
});

test("planned cancel edits the original message and removes buttons", async () => {
  const repo = fakeRepository();
  let cancelled = null;
  repo.cancelPlannedDraft = async (draftId, telegramUserId) => {
    cancelled = { draftId, telegramUserId };
    return null;
  };
  const calls = [];
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: {
      async sendMessage(message) {
        calls.push({ method: "sendMessage", ...message });
        return { ok: true };
      },
      async editMessageText(message) {
        calls.push({ method: "editMessageText", ...message });
        return { ok: true };
      },
      async answerCallbackQuery(message) {
        calls.push({ method: "answerCallbackQuery", ...message });
        return { ok: true };
      },
      async deleteMessage() {
        return { ok: true };
      }
    }
  });

  await bot.handleUpdate({
    callback_query: {
      id: "callback-plan-cancel",
      data: "plan_cancel:77",
      from: { id: 100 },
      message: { chat: { id: 10 }, message_id: 55 }
    }
  });

  assert.deepEqual(cancelled, { draftId: "77", telegramUserId: 100 });
  const edit = calls.find((call) => call.method === "editMessageText");
  assert.ok(edit);
  assert.equal(edit.chatId, 10);
  assert.equal(edit.messageId, 55);
  assert.match(edit.text, /Плановая трата отменена|Planned expense cancelled/);
  assert.deepEqual(edit.replyMarkup, { inline_keyboard: [] });
  assert.equal(calls.some((call) => call.method === "sendMessage"), false);
  assert.deepEqual(repo.events, [
    { userId: 1, eventName: "expense_draft_cancelled", metadata: { draftType: "planned" } }
  ]);
});

test("planned cancel sends a fallback message if editing fails", async () => {
  const repo = fakeRepository();
  const calls = [];
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: {
      async sendMessage(message) {
        calls.push({ method: "sendMessage", ...message });
        return { ok: true };
      },
      async editMessageText(message) {
        calls.push({ method: "editMessageText", ...message });
        throw new Error("edit failed");
      },
      async answerCallbackQuery(message) {
        calls.push({ method: "answerCallbackQuery", ...message });
        return { ok: true };
      },
      async deleteMessage() {
        return { ok: true };
      }
    }
  });

  await bot.handleUpdate({
    callback_query: {
      id: "callback-plan-cancel-fallback",
      data: "plan_cancel:77",
      from: { id: 100 },
      message: { chat: { id: 10 }, message_id: 55 }
    }
  });

  assert.ok(calls.some((call) => call.method === "editMessageText"));
  const fallback = calls.find((call) => call.method === "sendMessage");
  assert.ok(fallback);
  assert.match(fallback.text, /Плановая трата отменена|Planned expense cancelled/);
});

test("regular cancel edits the original message, removes buttons and records an event", async () => {
  const repo = fakeRepository();
  let cancelled = null;
  repo.cancelDraft = async (draftId, telegramUserId) => {
    cancelled = { draftId, telegramUserId };
    return { canceled: true };
  };
  const calls = [];
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: {
      async sendMessage(message) {
        calls.push({ method: "sendMessage", ...message });
        return { ok: true };
      },
      async editMessageText(message) {
        calls.push({ method: "editMessageText", ...message });
        return { ok: true };
      },
      async answerCallbackQuery(message) {
        calls.push({ method: "answerCallbackQuery", ...message });
        return { ok: true };
      },
      async deleteMessage(message) {
        calls.push({ method: "deleteMessage", ...message });
        return { ok: true };
      }
    }
  });

  await bot.handleUpdate({
    callback_query: {
      id: "callback-cancel-edit",
      data: "cancel:42",
      from: { id: 100 },
      message: { chat: { id: 10 }, message_id: 55 }
    }
  });

  assert.deepEqual(cancelled, { draftId: "42", telegramUserId: 100 });
  const edit = calls.find((call) => call.method === "editMessageText");
  assert.ok(edit);
  assert.equal(edit.chatId, 10);
  assert.equal(edit.messageId, 55);
  assert.match(edit.text, /Черновик отменён|Draft canceled/);
  assert.deepEqual(edit.replyMarkup, { inline_keyboard: [] });
  assert.ok(calls.some((call) => call.method === "answerCallbackQuery"));
  assert.equal(calls.some((call) => call.method === "sendMessage"), false);
  assert.equal(calls.some((call) => call.method === "deleteMessage"), false);
  assert.deepEqual(repo.events, [
    { userId: 1, eventName: "expense_draft_cancelled", metadata: { draftType: "regular" } }
  ]);
});

test("regular cancel sends a fallback message and does not throw if editing fails", async () => {
  const repo = fakeRepository();
  const calls = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    const bot = createTelegramBot({
      token: "test-token",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      telegramClient: {
        async sendMessage(message) {
          calls.push({ method: "sendMessage", ...message });
          return { ok: true };
        },
        async editMessageText(message) {
          calls.push({ method: "editMessageText", ...message });
          throw new Error("edit failed");
        },
        async answerCallbackQuery(message) {
          calls.push({ method: "answerCallbackQuery", ...message });
          return { ok: true };
        },
        async deleteMessage(message) {
          calls.push({ method: "deleteMessage", ...message });
          return { ok: true };
        }
      }
    });

    await assert.doesNotReject(() => bot.handleUpdate({
      callback_query: {
        id: "callback-cancel-fallback",
        data: "cancel:42",
        from: { id: 100 },
        message: { chat: { id: 10 }, message_id: 55 }
      }
    }));
  } finally {
    console.error = originalError;
  }

  assert.ok(calls.some((call) => call.method === "editMessageText"));
  const fallback = calls.find((call) => call.method === "sendMessage");
  assert.ok(fallback);
  assert.match(fallback.text, /Черновик отменён|Draft canceled/);
  assert.equal(calls.some((call) => call.method === "deleteMessage"), false);
  assert.deepEqual(repo.events, [
    { userId: 1, eventName: "expense_draft_cancelled", metadata: { draftType: "regular" } }
  ]);
});

test("admin stats shows non-zero metrics after message draft and confirm flow", async () => {
  const repo = fakeRepository();
  const messages = [];
  const statsService = {
    async getAdminStats() {
      const count = (name) => repo.events.filter((event) => event.eventName === name).length;
      const period = emptyProductPeriod({
        activeUsers: repo.events.length > 0 ? 1 : 0,
        expensesSaved: count("expense_saved"),
        draftsCreated: count("expense_draft_created"),
        draftsConfirmed: count("expense_draft_confirmed")
      });
      return emptyProductAdminStats({ periods: { today: period, last3Days: period, last7Days: period, last30Days: period } });
    }
  };
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    adminTelegramIds: new Set([100]),
    adminStatsService: statsService,
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate({
    message: {
      chat: { id: 10 },
      from: { id: 100, first_name: "M" },
      text: "coffee 70 baht"
    }
  });
  await bot.handleUpdate({
    callback_query: {
      id: "callback-confirm-stats",
      data: "confirm:42",
      from: { id: 100 },
      message: { chat: { id: 10 } }
    }
  });
  await bot.handleUpdate({
    message: {
      chat: { id: 10 },
      from: { id: 100, first_name: "M" },
      text: "/admin_stats"
    }
  });

  const statsMessage = messages.at(-1).text;
  assert.match(statsMessage, /Active users: <b>1<\/b>/);
  assert.match(statsMessage, /Expenses saved: <b>1<\/b>/);
  assert.match(statsMessage, /Drafts: <b>1 created \/ 0 confirmed/);
});

test("empty parse records a parse failure event", async () => {
  const repo = fakeRepository();
  const originalLog = console.log;
  console.log = () => {};
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      expenseParser: {
        async parse() {
          return { expenses: [] };
        }
      }
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        text: "no amount here"
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.ok(repo.events.some((event) => event.eventName === "expense_parse_failed"));
});

test("draft persistence failure is not counted as a parse failure", async () => {
  const repo = fakeRepository();
  repo.createDraft = async () => {
    throw new Error("database unavailable");
  };
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
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
        text: "coffee 70 baht"
      }
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(repo.events.some((event) => event.eventName === "expense_parse_failed"), false);
});

test("parser failures notify admins without changing the user-facing response", async () => {
  const repo = fakeRepository();
  repo.user = { ...repo.user, interface_language: "en" };
  const messages = [];
  const alerts = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    const bot = createTelegramBot({
      token: "test-token",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      telegramClient: captureTelegramClient(messages),
      expenseParser: {
        model: "gpt-test",
        async parse() {
          throw new Error("OpenAI failed with token=secret");
        }
      },
      adminAlertService: {
        async notifyAdminError(error, context) {
          alerts.push({ error, context });
        }
      }
    });

    await bot.handleUpdate(textUpdate("coffee 70", 100));
  } finally {
    console.error = originalError;
  }

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].error.message, "OpenAI failed with token=secret");
  assert.deepEqual(alerts[0].context, {
    source: "parser",
    operation: "expense_parse",
    telegramUserId: 100,
    userId: 1
  });
  assert.ok(messages.some((message) => /couldn.t parse the expense/i.test(message.text)));
});

test("async parser failures produce exactly one admin alert", async () => {
  const repo = fakeRepository();
  repo.user = { ...repo.user, interface_language: "en" };
  const messages = [];
  const alerts = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    const bot = createTelegramBot({
      token: "test-token",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      telegramClient: captureTelegramClient(messages),
      expenseParser: {
        model: "gpt-test",
        async parse() {
          throw new Error("OpenAI failed with token=secret");
        }
      },
      adminAlertService: {
        async notifyAdminError(error, context) {
          alerts.push({ error, context });
        }
      },
      awaitQueuedJobs: false
    });

    await bot.handleUpdate(textUpdate("coffee 70", 100));
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    console.error = originalError;
  }

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].context.source, "parser");
  assert.equal(alerts[0].context.operation, "expense_parse");
  assert.ok(messages.some((message) => /couldn.t parse the expense/i.test(message.text)));
});

test("unhandled Telegram update failures notify admins and still reject", async () => {
  const alerts = [];
  const repo = fakeRepository();
  repo.upsertTelegramUser = async () => {
    throw new Error("database unavailable");
  };
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: captureTelegramClient([]),
    adminAlertService: {
      async notifyAdminError(error, context) {
        alerts.push({ error, context });
      }
    }
  });

  await assert.rejects(
    bot.handleUpdate(textUpdate("coffee 70", 100)),
    /database unavailable/
  );

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].context.source, "telegram");
  assert.equal(alerts[0].context.operation, "handle_update");
  assert.equal(alerts[0].context.telegramUserId, 100);
});

test("voice transcription failure records an event and returns an error response", async () => {
  const repo = fakeRepository();
  const messages = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    const bot = createTelegramBot({
      token: "test-token",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      telegramClient: captureTelegramClient(messages),
      voiceTranscriber: {
        isConfigured: () => true,
        async transcribeTelegramVoice() {
          throw new Error("transcription unavailable");
        }
      }
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        voice: { file_id: "voice-file-id", mime_type: "audio/ogg" }
      }
    });
  } finally {
    console.error = originalError;
  }

  assert.ok(repo.events.some((event) => event.eventName === "voice_transcription_failed"));
  assert.match(messages.at(-1).text, /Не смог разобрать голосовое|couldn.t understand the voice message/i);
  const completed = repo.events.find((event) => event.eventName === "message_processing_completed");
  assert.equal(completed.metadata.result, "transcription_failed");
  assert.equal(completed.metadata.status, "transcription_failed");
});

test("voice amount-not-found response includes the escaped transcript", async () => {
  const repo = fakeRepository();
  const messages = [];
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: captureTelegramClient(messages),
    voiceTranscriber: {
      isConfigured: () => true,
      async transcribeTelegramVoice() {
        return "<b>rent reminder</b> ".repeat(10);
      }
    },
    expenseParser: {
      async parse() {
        return { expenses: [] };
      }
    }
  });

  await bot.handleUpdate({
    message: {
      chat: { id: 10 },
      from: { id: 100, first_name: "M" },
      voice: { file_id: "voice-file-id", mime_type: "audio/ogg" }
    }
  });

  const response = messages.at(-1).text;
  assert.match(response, /Я услышал|I heard/);
  assert.match(response, /&lt;b&gt;rent reminder&lt;\/b&gt;/);
  assert.doesNotMatch(response, /<b>rent reminder<\/b>/);
  assert.match(response, /…/);
  assert.ok((response.match(/rent reminder/g) ?? []).length < 10);
  const completed = repo.events.find((event) => event.eventName === "message_processing_completed");
  assert.equal(completed.metadata.result, "amount_not_found");
  assert.equal(completed.metadata.status, "amount_not_found");
});

test("photo input returns a friendly unsupported-photo response without creating a draft", async () => {
  const repo = fakeRepository();
  const messages = [];
  let draftCreated = false;
  repo.createDraft = async () => {
    draftCreated = true;
    return { id: 42 };
  };
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate({
    message: {
      chat: { id: 10 },
      from: { id: 100, first_name: "M" },
      photo: [{ file_id: "photo-small" }, { file_id: "photo-large" }]
    }
  });

  assert.ok(repo.events.some((event) => event.eventName === "message_received" && event.metadata.inputType === "photo"));
  assert.equal(draftCreated, false);
  assert.match(messages.at(-1).text, /Фото чеков пока не умею читать|can.t read receipt photos yet/i);
  assert.ok(repo.events.some((event) => event.eventName === "unsupported_photo_input" && event.metadata.inputType === "photo"));
  const completed = repo.events.find((event) => event.eventName === "message_processing_completed");
  assert.equal(completed.metadata.result, "unsupported_photo");
  assert.equal(completed.metadata.status, "unsupported_photo");
});

test("enabled evidence import routes a photo to the import service and keeps its caption out of Telegram output", async () => {
  const repo = fakeRepository();
  const messages = [];
  const calls = [];
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: captureTelegramClient(messages),
    expenseEvidenceImportService: {
      async importImage(input) {
        calls.push(input);
        return { state: "ready", importId: 77, evidenceType: "receipt", candidates: [{ ordinal: 0 }] };
      }
    }
  });

  await bot.handleUpdate({ message: { chat: { id: 10 }, from: { id: 100, first_name: "M" }, message_id: 9, caption: "private supermarket receipt", photo: [{ file_id: "small", file_unique_id: "u1" }, { file_id: "large", file_unique_id: "u2" }] } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].fileId, "large");
  assert.equal(calls[0].fileUniqueId, "u2");
  assert.equal(calls[0].caption, "private supermarket receipt");
  assert.doesNotMatch(messages.at(-1).text, /private supermarket receipt/);
  assert.equal(messages.at(-1).text, "Готово к проверке: 1 расход.");
  assert.deepEqual(messages.at(-1).replyMarkup.inline_keyboard.flat().map((button) => button.callback_data), [
    "ei:77:save", "ei:77:review", "ei:77:cancel", "es:77:start"
  ]);
});

test("starting a catch-up session links the Phase 1 import and collects the next image only in that session", async () => {
  const repo = fakeRepository();
  const messages = [];
  const imports = [];
  const linked = [];
  repo.getExpenseEvidenceImport = async (userId, importId) => userId === 1 && importId === "77"
    ? { id: 77, candidates: [{ id: 5, status: "ready", draftId: 44 }] }
    : null;
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo,
    telegramClient: captureTelegramClient(messages),
    expenseEvidenceImportService: {
      async importImage(input) { imports.push(input); return { state: "ready", importId: 78, evidenceType: "receipt", candidates: [{ ordinal: 0 }] }; }
    },
    expenseEvidenceSessionService: {
      async startOrResume(input) { assert.deepEqual(input, { userId: 1, chatId: 10 }); return { state: "started", id: 41, expiresAt: new Date("2026-09-05T12:15:00.000Z") }; },
      async linkCompletedImport(input) { linked.push(input); return { state: "linked" }; }
    },
    now: () => new Date("2026-09-05T12:00:00.000Z")
  });

  await bot.handleUpdate({ callback_query: { id: "session-start", data: "es:77:start", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 21 } } });
  assert.deepEqual(linked, [{ userId: 1, chatId: 10, sessionId: 41, imported: { id: 77, state: "ready" } }]);
  assert.equal(messages.at(-1).text, "Добавьте фото, затем нажмите «Готово».");
  assert.deepEqual(messages.at(-1).replyMarkup.inline_keyboard.flat().map((button) => button.callback_data), ["es:41:add", "es:41:finish", "es:41:cancel"]);

  await bot.handleUpdate({ message: { chat: { id: 10 }, from: { id: 100, first_name: "M" }, message_id: 22, photo: [{ file_id: "next-photo" }] } });
  assert.equal(imports.length, 1);
  assert.deepEqual(linked.at(-1), { userId: 1, chatId: 10, sessionId: 41, imported: { state: "ready", importId: 78, evidenceType: "receipt", candidates: [{ ordinal: 0 }] } });
  assert.equal(messages.at(-1).text, "Фото добавлено. Добавьте ещё или нажмите «Готово».");
  assert.deepEqual(messages.at(-1).replyMarkup.inline_keyboard.flat().map((button) => button.callback_data), ["es:41:add", "es:41:finish", "es:41:cancel"]);
});

test("catch-up finish shows aggregate-only preview and batch save stays scoped to its chat session", async () => {
  const repo = fakeRepository();
  const messages = [];
  const resolved = [];
  repo.getExpenseEvidenceImport = async () => ({ id: 77, candidates: [{ id: 5, status: "ready", draftId: 44 }] });
  repo.getExpenseEvidenceSessionCandidates = async () => [{ importId: 77, candidateId: 5, status: "ready", draftId: 44, evidenceType: "receipt" }];
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo,
    telegramClient: captureTelegramClient(messages),
    expenseEvidenceImportService: {},
    expenseEvidenceSessionService: {
      async startOrResume() { return { state: "started", id: 41, expiresAt: new Date("2026-09-05T12:15:00.000Z") }; },
      async linkCompletedImport() { return { state: "linked" }; },
      async finish() { return { state: "ready", id: 41, preview: { importCount: 2, candidateCount: 3, unresolvedCount: 2, duplicateCount: 1 } }; },
      async resolve(input) { resolved.push(input); return { outcomes: [{ candidateId: 5, state: "saved" }] }; }
    },
    now: () => new Date("2026-09-05T12:00:00.000Z")
  });
  const callback = (id, data, chatId = 10) => bot.handleUpdate({ callback_query: { id, data, from: { id: 100 }, message: { chat: { id: chatId }, message_id: 21 } } });

  await callback("start", "es:77:start");
  await callback("finish", "es:41:finish");
  assert.equal(messages.at(-1).text, "Готово: 2 изображения, 2 расхода к проверке.");
  assert.doesNotMatch(messages.at(-1).text, /receipt|draftId|44/i);
  assert.deepEqual(messages.at(-1).replyMarkup.inline_keyboard.flat().map((button) => button.callback_data), ["es:41:save", "es:41:review", "es:41:cancel"]);

  await callback("other-chat", "es:41:save", 11);
  assert.equal(resolved.length, 0);
  await callback("save", "es:41:save");
  assert.deepEqual(resolved, [{ userId: 1, sessionId: 41, actions: [{ candidateId: 5, action: "save" }] }]);
});

test("catch-up preview cancel delegates unresolved resolution and closes the ready session", async () => {
  const repo = fakeRepository();
  const messages = [];
  const cancelled = [];
  repo.getExpenseEvidenceImport = async () => ({ id: 77, candidates: [] });
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo,
    telegramClient: captureTelegramClient(messages),
    expenseEvidenceImportService: {},
    expenseEvidenceSessionService: {
      async startOrResume() { return { state: "started", id: 41, expiresAt: new Date("2026-09-05T12:15:00.000Z") }; },
      async linkCompletedImport() { return { state: "linked" }; },
      async finish() { return { state: "ready", id: 41, preview: { importCount: 1, unresolvedCount: 1 } }; },
      async cancel(input) { cancelled.push(input); return { state: "cancelled", id: 41, outcomes: [{ candidateId: 5, state: "cancelled" }] }; }
    },
    now: () => new Date("2026-09-05T12:00:00.000Z")
  });
  const callback = (id, data) => bot.handleUpdate({ callback_query: { id, data, from: { id: 100 }, message: { chat: { id: 10 }, message_id: 21 } } });

  await callback("start", "es:77:start");
  await callback("finish", "es:41:finish");
  await callback("cancel", "es:41:cancel");

  assert.deepEqual(cancelled, [{ userId: 1, chatId: 10, sessionId: 41 }]);
  assert.equal(messages.at(-1).text, "Сессия отменена.");
  assert.deepEqual(messages.at(-1).replyMarkup, { inline_keyboard: [] });
});

test("expired request-scoped catch-up session leaves the next image as a standalone Phase 1 import", async () => {
  const repo = fakeRepository();
  const messages = [];
  const linked = [];
  let currentTime = new Date("2026-09-05T12:00:00.000Z");
  repo.getExpenseEvidenceImport = async () => ({ id: 77, candidates: [] });
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo,
    telegramClient: captureTelegramClient(messages),
    expenseEvidenceImportService: { async importImage() { return { state: "ready", importId: 78, evidenceType: "receipt", candidates: [{ ordinal: 0 }] }; } },
    expenseEvidenceSessionService: {
      async startOrResume() { return { state: "started", id: 41, expiresAt: new Date("2026-09-05T12:01:00.000Z") }; },
      async linkCompletedImport(input) { linked.push(input); return { state: "linked" }; }
    },
    now: () => currentTime
  });
  await bot.handleUpdate({ callback_query: { id: "start", data: "es:77:start", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 21 } } });
  currentTime = new Date("2026-09-05T12:01:00.000Z");
  await bot.handleUpdate({ message: { chat: { id: 10 }, from: { id: 100, first_name: "M" }, message_id: 22, photo: [{ file_id: "standalone-after-expiry" }] } });

  assert.equal(linked.length, 1);
  assert.equal(messages.at(-1).text, "Готово к проверке: 1 расход.");
  assert.deepEqual(messages.at(-1).replyMarkup.inline_keyboard.flat().map((button) => button.callback_data), ["ei:78:save", "ei:78:review", "ei:78:cancel", "es:78:start"]);
});

test("active catch-up session links a PNG document without exposing its caption", async () => {
  const repo = fakeRepository();
  const messages = [];
  const linked = [];
  repo.getExpenseEvidenceImport = async () => ({ id: 77, candidates: [] });
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo,
    telegramClient: captureTelegramClient(messages),
    expenseEvidenceImportService: { async importImage() { return { state: "ready", importId: 78, evidenceType: "receipt", candidates: [{ ordinal: 0 }] }; } },
    expenseEvidenceSessionService: {
      async startOrResume() { return { state: "started", id: 41, expiresAt: new Date("2026-09-05T12:15:00.000Z") }; },
      async linkCompletedImport(input) { linked.push(input); return { state: "linked" }; }
    },
    now: () => new Date("2026-09-05T12:00:00.000Z")
  });
  await bot.handleUpdate({ callback_query: { id: "start", data: "es:77:start", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 21 } } });
  await bot.handleUpdate({ message: { chat: { id: 10 }, from: { id: 100, first_name: "M" }, message_id: 22, caption: "private purchase note", document: { file_id: "png-file", mime_type: "image/png" } } });

  assert.equal(linked.at(-1).sessionId, 41);
  assert.doesNotMatch(messages.at(-1).text, /private purchase note|png-file/);
  assert.equal(messages.at(-1).text, "Фото добавлено. Добавьте ещё или нажмите «Готово».");
});

test("English evidence summary and actions are localized", async () => {
  const repo = fakeRepository();
  repo.user = { ...repo.user, interface_language: "en" };
  const messages = [];
  const bot = createTelegramBot({ token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient: captureTelegramClient(messages), expenseEvidenceImportService: {
    async importImage() { return { state: "ready", importId: 77, evidenceType: "receipt", candidates: [{ ordinal: 0 }] }; }
  } });
  await bot.handleUpdate({ message: { chat: { id: 10 }, from: { id: 100, first_name: "M" }, message_id: 9, photo: [{ file_id: "photo" }] } });
  assert.equal(messages.at(-1).text, "Ready to review: 1 expense.");
  assert.doesNotMatch(messages.at(-1).text, /Готово|расход/);
  assert.deepEqual(messages.at(-1).replyMarkup.inline_keyboard.flat().map((button) => button.text), ["✅ Save", "🔎 Review", "🗑 Cancel", "➕ Add another photo"]);
});

test("confirming an edited evidence draft marks it once and advances to the next candidate", async () => {
  const repo = fakeRepository();
  const calls = [];
  repo.confirmDraftWithExplicitAcceptance = async () => ({ expenses: [{ id: 71, amount_base: 75, amount_original: 75, currency_original: "THB", category_slug: "food_cafe", description: "breakfast" }], dashboardSnapshot: null, alreadySaved: false });
  repo.getExpenseEvidenceImport = async () => ({ id: 77, candidates: [{ id: 5, status: "saved", draftId: 42 }, { id: 6, status: "ready", draftId: 43 }] });
  const marked = [];
  const bot = createTelegramBot({ token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient: capturingClient(calls), expenseEvidenceImportService: {
    async getActiveCandidateForDraft(input) { return input.draftId === "42" ? { importId: 77, candidateId: 5, draftId: 42, status: "ready" } : null; },
    async markCandidateSavedAfterDraftConfirmation(input) { marked.push(input); return { state: "saved" }; }
  } });

  await bot.handleUpdate({ callback_query: { id: "confirm-evidence", data: "confirm:42", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 55 } } });

  assert.deepEqual(marked, [{ userId: 1, draftId: "42" }]);
  const edited = calls.find((call) => call.method === "editMessageText");
  assert.equal(edited.text, "Проверьте расход перед сохранением.");
  assert.equal(edited.replyMarkup.inline_keyboard[0][0].callback_data, "ei:77:6:accounted");
});

test("enabled evidence import routes JPEG and PNG documents without exposing their caption or file id", async (t) => {
  for (const mimeType of ["image/jpeg", "image/png"]) {
    await t.test(mimeType, async () => {
      const repo = fakeRepository();
      const messages = [];
      const calls = [];
      const bot = createTelegramBot({
        token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo,
        telegramClient: captureTelegramClient(messages),
        expenseEvidenceImportService: {
          async importImage(input) {
            calls.push(input);
            return { state: "ready", importId: 77, evidenceType: "receipt", candidates: [{ ordinal: 0 }] };
          }
        }
      });

      await bot.handleUpdate({ message: {
        chat: { id: 10 }, from: { id: 100, first_name: "M" }, message_id: 9,
        caption: "private caption", document: { file_id: "secret-file-id", file_unique_id: "u2", mime_type: mimeType }
      } });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].declaredMimeType, mimeType);
      assert.doesNotMatch(messages.at(-1).text, /private caption|secret-file-id/);
      assert.equal(messages.at(-1).text, "Готово к проверке: 1 расход.");
    });
  }
});

test("non-image document stays unsupported when evidence import is enabled", async () => {
  const repo = fakeRepository();
  const messages = [];
  let imports = 0;
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo,
    telegramClient: captureTelegramClient(messages),
    expenseEvidenceImportService: { async importImage() { imports += 1; } }
  });

  await bot.handleUpdate({ message: { chat: { id: 10 }, from: { id: 100, first_name: "M" }, document: { file_id: "doc", mime_type: "application/pdf" } } });

  assert.equal(imports, 0);
  assert.match(messages.at(-1).text, /только текстовые и голосовые|only text and voice/i);
});

test("evidence save callback resolves only the owner's ready candidates", async () => {
  const repo = fakeRepository();
  const messages = [];
  const actions = [];
  repo.getExpenseEvidenceImport = async (userId, importId) => {
    assert.equal(userId, 1);
    assert.equal(importId, "77");
    return { id: 77, status: "ready", candidates: [{ id: 5, status: "ready", draftId: 44 }] };
  };
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo,
    telegramClient: captureTelegramClient(messages),
    expenseEvidenceImportService: {
      async resolveImportCandidates(input) { actions.push(input); return { outcomes: [{ candidateId: 5, state: "saved" }] }; }
    }
  });

  await bot.handleUpdate({ callback_query: { id: "evidence-save", data: "ei:77:save", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 21 } } });

  assert.deepEqual(actions, [{ userId: 1, importId: "77", actions: [{ candidateId: 5, action: "save" }] }]);
  const edited = messages.find((message) => message.messageId === 21);
  assert.equal(edited?.text, "Импорт обработан.");
  assert.deepEqual(edited?.replyMarkup, { inline_keyboard: [] });
});

test("evidence callback rejects imports outside the Telegram user's ownership", async () => {
  const repo = fakeRepository();
  const messages = [];
  let resolved = false;
  repo.getExpenseEvidenceImport = async () => null;
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo,
    telegramClient: captureTelegramClient(messages),
    expenseEvidenceImportService: { async resolveImportCandidates() { resolved = true; } }
  });

  await bot.handleUpdate({ callback_query: { id: "evidence-other-user", data: "ei:77:cancel", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 21 } } });

  assert.equal(resolved, false);
});

test("evidence cancel callback resolves each owned ready candidate", async () => {
  const repo = fakeRepository();
  const inputs = [];
  repo.getExpenseEvidenceImport = async () => ({ id: 77, status: "ready", candidates: [{ id: 5, status: "ready", draftId: 44 }, { id: 6, status: "saved", draftId: 45 }] });
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo,
    telegramClient: captureTelegramClient([]),
    expenseEvidenceImportService: { async resolveImportCandidates(input) { inputs.push(input); return { outcomes: [{ candidateId: 5, state: "cancelled" }] }; } }
  });

  await bot.handleUpdate({ callback_query: { id: "evidence-cancel", data: "ei:77:cancel", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 21 } } });

  assert.deepEqual(inputs, [{ userId: 1, importId: "77", actions: [{ candidateId: 5, action: "cancel" }] }]);
});

test("stale evidence candidate callback does not resolve a candidate twice", async () => {
  const repo = fakeRepository();
  let resolved = false;
  let calls = 0;
  repo.getExpenseEvidenceImport = async () => ({ id: 77, candidates: [{ id: 5, status: resolved ? "saved" : "ready", draftId: 44 }] });
  const bot = createTelegramBot({ token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient: captureTelegramClient([]), expenseEvidenceImportService: {
    async resolveImportCandidates() { calls += 1; resolved = true; return { outcomes: [{ candidateId: 5, state: "saved" }] }; }
  } });
  const callback = (id) => bot.handleUpdate({ callback_query: { id, data: "ei:77:5:add", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 21 } } });
  await callback("fresh");
  await callback("stale");
  assert.equal(calls, 1);
});

test("evidence review advances to the next candidate after accounted or add", async (t) => {
  for (const [callbackAction, serviceAction] of [["accounted", "already_accounted"], ["add", "add"]]) {
    await t.test(callbackAction, async () => {
      const repo = fakeRepository();
      const messages = [];
      const actions = [];
      let resolved = false;
      repo.getExpenseEvidenceImport = async () => ({ id: 77, status: "ready", candidates: resolved
        ? [{ id: 5, status: "saved", draftId: 44 }, { id: 6, status: "ready", draftId: 45 }]
        : [{ id: 5, status: "ready", draftId: 44 }, { id: 6, status: "ready", draftId: 45 }]
      });
      const bot = createTelegramBot({
        token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo,
        telegramClient: captureTelegramClient(messages),
        expenseEvidenceImportService: { async resolveImportCandidates(input) { actions.push(input); resolved = true; return { outcomes: [{ candidateId: 5, state: "saved" }] }; } }
      });

      await bot.handleUpdate({ callback_query: { id: `review-${callbackAction}`, data: "ei:77:review", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 21 } } });
      assert.equal(messages.at(-1).replyMarkup.inline_keyboard[0][0].callback_data, "ei:77:5:accounted");
      await bot.handleUpdate({ callback_query: { id: callbackAction, data: `ei:77:5:${callbackAction}`, from: { id: 100 }, message: { chat: { id: 10 }, message_id: 21 } } });

      assert.deepEqual(actions, [{ userId: 1, importId: "77", actions: [{ candidateId: 5, action: serviceAction }] }]);
      assert.equal(messages.at(-1).replyMarkup.inline_keyboard[0][0].callback_data, "ei:77:6:accounted");
    });
  }
});

test("evidence edit delegates to the existing draft editor", async () => {
  const repo = fakeRepository();
  const messages = [];
  const draftCalls = [];
  repo.getExpenseEvidenceImport = async () => ({ id: 77, candidates: [{ id: 5, status: "ready", draftId: 44 }] });
  repo.getDraftForTelegramUser = async (...args) => {
    draftCalls.push(args);
    return { id: 44, items: [{ amount: 70, currency: "THB", description: "coffee", category_slug: "food_cafe", spent_at: "2026-08-14T12:00:00.000Z", budget_impact: "regular" }] };
  };
  const bot = createTelegramBot({ token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient: captureTelegramClient(messages), expenseEvidenceImportService: {} });

  await bot.handleUpdate({ callback_query: { id: "evidence-edit", data: "ei:77:5:edit", from: { id: 100 }, message: { chat: { id: 10 }, message_id: 21 } } });

  assert.deepEqual(draftCalls, [[44, 100]]);
  assert.ok(messages.at(-1).replyMarkup.inline_keyboard.flat().some((button) => button.callback_data === "ee:d:44:0:f:a"));
});

test("throwing event logger does not break expense processing", async () => {
  const repo = fakeRepository();
  repo.recordAppEvent = async () => {
    throw new Error("events unavailable");
  };
  const calls = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => calls.push(args);
  console.warn = () => {};
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: repo
    });

    await assert.doesNotReject(() => bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        text: "coffee 70 baht"
      }
    }));
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  assert.ok(calls.length >= 2);
});

test("sendMessage retries as plain text when Telegram rejects HTML", async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, request) => {
    requests.push({ url: String(url), body: JSON.parse(request.body) });
    const hasHtmlTags = /<\/?b>/.test(requests[requests.length - 1].body.text ?? "");
    if (hasHtmlTags && requests.filter((r) => r.url.endsWith("/sendMessage") || r.url.endsWith("/editMessageText")).length <= 2) {
      return {
        ok: false,
        status: 400,
        async text() {
          return JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" });
        }
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result: { message_id: 1 } };
      },
      async text() {
        return JSON.stringify({ ok: true });
      }
    };
  };

  try {
    const bot = createTelegramBot({
      token: "test-token",
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
  } finally {
    globalThis.fetch = originalFetch;
  }

  const draftRequests = requests.filter((request) => request.url.endsWith("/editMessageText"));
  assert.equal(draftRequests.length, 2);
  assert.equal(draftRequests[0].body.parse_mode, "HTML");
  assert.equal(draftRequests[1].body.parse_mode, undefined);
  assert.doesNotMatch(draftRequests[1].body.text, /<b>/);
  assert.match(draftRequests[1].body.text, /70 THB/);
});

test("sendMessage omits reply markup when no keyboard is provided", async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, request) => {
    requests.push({ url: String(url), body: JSON.parse(request.body) });
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result: { message_id: 1 } };
      }
    };
  };

  try {
    const bot = createTelegramBot({
      token: "test-token",
      miniAppUrl: "http://localhost:3000",
      repository: fakeRepository()
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        text: "hello without amount"
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(Object.hasOwn(request.body, "reply_markup"), false);
  }
});

test("admin stats command sends stats only to configured admin ids", async () => {
  const calls = [];
  const originalLog = console.log;
  console.log = (...args) => calls.push(args);
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: fakeRepository(),
      adminTelegramIds: new Set([100]),
      adminStatsService: {
        async getAdminStats() {
          return emptyProductAdminStats({ periods: {
            today: emptyProductPeriod({ activeUsers: 1 }),
            last3Days: emptyProductPeriod(), last7Days: emptyProductPeriod(), last30Days: emptyProductPeriod()
          } });
        }
      }
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        text: "/admin_stats"
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(calls.length, 1);
  assert.match(calls[0][1].text, /Product stats/);
  assert.match(calls[0][1].text, /Today/);
  assert.match(calls[0][1].text, /Active users: <b>1<\/b> \/ new users: 0/);
});

test("admin stats accepts numeric-string ids and bot command suffixes", async () => {
  const messages = [];
  let serviceCalls = 0;
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: fakeRepository(),
    adminTelegramIds: new Set([100]),
    adminStatsService: {
      async getAdminStats() {
        serviceCalls += 1;
        return emptyProductAdminStats();
      }
    },
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate({
    message: {
      chat: { id: 10 },
      from: { id: "100", first_name: "M" },
      text: "/admin_stats@MoneyFlowBot"
    }
  });

  assert.equal(serviceCalls, 1);
  assert.match(messages[0].text, /Product stats/);
});

test("technical admin stats use the separate suffixed command", async () => {
  const messages = [];
  let calls = 0;
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: fakeRepository(),
    adminTelegramIds: new Set([100]),
    adminStatsService: {
      async getTechnicalStats() {
        calls += 1;
        return { today: emptyAdminPeriod(), last7Days: emptyAdminPeriod() };
      }
    },
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate(textUpdate("/admin_stats_tech@MoneyFlowBot", 100));

  assert.equal(calls, 1);
  assert.match(messages[0].text, /Technical stats/);
  assert.match(messages[0].text, /Today — Traffic/);
  assert.doesNotMatch(messages[0].text, /Last 30 days/);
});

test("admin stats use multipart Telegram HTML instead of Rich Messages", async () => {
  const sent = [];
  let richMessageCalls = 0;
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: fakeRepository(),
    adminTelegramIds: new Set([100]),
    adminStatsService: {
      async getAdminStats() {
        return emptyProductAdminStats({ periods: {
          today: emptyProductPeriod({ activeUsers: 2, expensesSaved: 5 }),
          last3Days: emptyProductPeriod(), last7Days: emptyProductPeriod(), last30Days: emptyProductPeriod()
        } });
      },
      async getTechnicalStats() {
        return { today: emptyAdminPeriod({ p95TextSeconds: 1.2 }), last7Days: emptyAdminPeriod() };
      }
    },
    telegramClient: {
      async sendMessage(message) { sent.push(message); return { ok: true }; },
      async sendRichMessage() { richMessageCalls += 1; return { ok: true }; }
    }
  });

  await bot.handleUpdate(textUpdate("/admin_stats", 100));
  await bot.handleUpdate(textUpdate("/admin_stats_tech", 100));

  assert.equal(richMessageCalls, 0);
  const html = sent.map((message) => message.text).join("\n");
  assert.match(html, /Active users: <b>2<\/b>/);
  assert.match(html, /Expenses saved: <b>5<\/b>/);
  assert.match(html, /P95 processing:/);
  assert.doesNotMatch(html, /<(table|details)\b/i);
});

test("product and technical admin stats fail independently", async () => {
  const messages = [];
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: fakeRepository(),
    adminTelegramIds: new Set([100]),
    adminStatsService: {
      async getTechnicalStats() { throw new Error("technical down"); }
    },
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate(textUpdate("/admin_stats", 100));
  await bot.handleUpdate(textUpdate("/admin_stats_tech", 100));

  assert.deepEqual(messages.map((message) => message.text), [
    "Product stats unavailable",
    "Technical stats unavailable"
  ]);
});

test("admin stats command does not reveal stats to non-admin users", async () => {
  const calls = [];
  const warnings = [];
  const rawAdminEnv = "\"100\"";
  let serviceCalled = false;
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => calls.push(args);
  console.warn = (...args) => warnings.push(args);
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: fakeRepository(),
      adminTelegramIds: parseAdminTelegramIds(rawAdminEnv),
      adminStatsService: {
        async getAdminStats() {
          serviceCalled = true;
          return {};
        }
      }
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 200, first_name: "M", username: "not_admin" },
        text: "/admin_stats"
      }
    });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  assert.equal(serviceCalled, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].text, "Access denied");
  assert.deepEqual(warnings, [[
    "[admin] access denied",
    {
      command: "/admin_stats",
      fromId: 200,
      username: "not_admin",
      chatId: 10,
      adminIdsCount: 1,
      adminEnvConfigured: true
    }
  ]]);
  assert.doesNotMatch(JSON.stringify(warnings), new RegExp(rawAdminEnv.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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

test("new user chooses language and completes budget setup in one message before the 5th", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.user = { id: 1, interface_language: "en", base_currency: "THB", onboarding_step: "language", onboarding_data: {} };
  const originalLog = console.log;
  console.log = (...args) => calls.push(args);
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      now: () => new Date("2026-06-05T10:00:00+07:00")
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
        text: "English"
      }
    });
    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        text: "IDR 20k"
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.match(calls[0][1].text, /Choose language/i);
  assert.match(calls[1][1].text, /write or dictate/i);
  assert.match(calls[1][1].text, /currency and monthly budget/i);
  assert.match(calls[2][1].text, /setup is complete/i);
  assert.equal(repo.user.interface_language, "en");
  assert.equal(repo.user.onboarding_step, "completed");
  assert.equal(repo.settings.baseCurrency, "IDR");
  assert.equal(repo.settings.monthlyBudgetAmount, 20000);
  assert.equal(repo.currentMonthBudget, null);
  assert.deepEqual(
    repo.events.map((event) => event.eventName),
    [
      "bot_started",
      "onboarding_started",
      "currency_selected",
      "budget_set",
      "onboarding_completed"
    ]
  );
  assert.deepEqual(repo.events.find((event) => event.eventName === "budget_set").metadata, {
    currency: "IDR",
    budgetType: "monthly"
  });
  assert.doesNotMatch(JSON.stringify(repo.events), /20000/);
});

test("/start self-heals a completed user's localized private command menu", async () => {
  const messages = [];
  const commandCalls = [];
  const repo = fakeRepository();
  repo.user = { id: 1, interface_language: "ru", base_currency: "THB", onboarding_step: "completed" };
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: {
      ...captureTelegramClient(messages),
      async setMyCommands(payload) { commandCalls.push(payload); return { ok: true }; },
      async setChatMenuButton() { return { ok: true }; }
    }
  });

  await bot.handleUpdate(textUpdate("/start", 100));

  assert.equal(commandCalls.length, 1);
  assert.deepEqual(commandCalls[0].scope, { type: "chat", chatId: 10 });
  assert.equal(commandCalls[0].commands.some((command) => command.command === "start"), false);
  assert.equal(commandCalls[0].commands.find((command) => command.command === "help").description, "❓ Как пользоваться");
  assert.equal(messages.length, 1);
});

test("/help gives short equivalent guidance in RU and EN without entering expense parsing", async () => {
  for (const [language, title, example] of [
    ["ru", "Как пользоваться Money Flow", "кофе 120"],
    ["en", "How to use Money Flow", "coffee 120"]
  ]) {
    const messages = [];
    const repo = fakeRepository();
    repo.user = { id: 1, interface_language: language, base_currency: "THB", onboarding_step: "completed" };
    const bot = createTelegramBot({
      token: "test-token",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      telegramClient: captureTelegramClient(messages),
      expenseParser: { async parse() { throw new Error("help must not enter the parser"); } }
    });

    await bot.handleUpdate(textUpdate("/help", 100));

    assert.match(messages[0].text, new RegExp(title));
    assert.match(messages[0].text, new RegExp(example));
    assert.match(messages[0].text, /\/last/);
    assert.match(messages[0].text, /Mini App/);
  }
});

test("completing Telegram onboarding replaces the menu with the compact set", async () => {
  const messages = [];
  const commandCalls = [];
  const repo = fakeRepository();
  repo.user = { id: 1, interface_language: "en", base_currency: "THB", onboarding_step: "budget_setup", onboarding_data: {} };
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    now: () => new Date("2026-06-05T10:00:00+07:00"),
    telegramClient: {
      ...captureTelegramClient(messages),
      async setMyCommands(payload) { commandCalls.push(payload); return { ok: true }; },
      async setChatMenuButton() { return { ok: true }; }
    }
  });

  await bot.handleUpdate(textUpdate("USD 2000", 100));

  assert.equal(repo.user.onboarding_step, "completed");
  assert.equal(commandCalls.length, 1);
  assert.equal(commandCalls[0].commands.some((command) => command.command === "start"), false);
});

test("Russian language callback sends Russian budget setup text", async () => {
  const messages = [];
  const repo = fakeRepository();
  repo.user = { id: 1, interface_language: "en", base_currency: "THB", onboarding_step: "language", onboarding_data: {} };
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate({
    callback_query: {
      id: "callback-1",
      data: "onboard_lang:ru",
      from: { id: 100 },
      message: { chat: { id: 10 } }
    }
  });

  assert.match(messages[0].text, /Money Flow помогает/);
  assert.match(messages[0].text, /Теперь отправь валюту и месячный бюджет/);
  assert.doesNotMatch(messages[0].text, /helps you save expenses/i);
  assert.doesNotMatch(messages[0].text, /currency and monthly budget/i);
  assert.equal(repo.user.interface_language, "ru");
  assert.equal(repo.user.onboarding_step, "budget_setup");
});

test("budget setup can collect currency and monthly budget step by step", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.user = { id: 1, interface_language: "en", base_currency: "THB", onboarding_step: "budget_setup", onboarding_data: {} };
  const originalLog = console.log;
  console.log = (...args) => calls.push(args);
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      now: () => new Date("2026-06-05T10:00:00+07:00")
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        text: "USD"
      }
    });
    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        text: "2000"
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.match(calls[0][1].text, /monthly budget/i);
  assert.match(calls[1][1].text, /setup is complete/i);
  assert.equal(repo.user.onboarding_data.currency, undefined);
  assert.equal(repo.settings.baseCurrency, "USD");
  assert.equal(repo.settings.monthlyBudgetAmount, 2000);
});

test("budget setup after the 5th asks for current partial-month budget", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.user = { id: 1, interface_language: "en", base_currency: "THB", onboarding_step: "budget_setup", onboarding_data: {} };
  const originalLog = console.log;
  console.log = (...args) => calls.push(args);
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      now: () => new Date("2026-06-12T10:00:00+07:00")
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        text: "USD 2000"
      }
    });
    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        text: "900"
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.match(calls[0][1].text, /until the end of this month/);
  assert.match(calls[1][1].text, /setup is complete/i);
  assert.equal(repo.settings.baseCurrency, "USD");
  assert.equal(repo.settings.monthlyBudgetAmount, 2000);
  assert.equal(repo.currentMonthBudget.amount, 900);
  assert.equal(repo.currentMonthBudget.currency, "USD");
});

test("completed budget setup before and after the 5th allows the next expense to become a regular draft", async () => {
  for (const scenario of [
    { name: "before the 5th", now: "2026-06-05T10:00:00+07:00", onboardingMessages: ["English", "THB 42000"] },
    { name: "after the 5th", now: "2026-06-12T10:00:00+07:00", onboardingMessages: ["English", "THB 42000", "skip"] }
  ]) {
    const calls = [];
    const parserCalls = [];
    const repo = fakeRepository();
    repo.user = { id: 1, interface_language: "en", base_currency: "THB", onboarding_step: "language", onboarding_data: {} };
    const originalLog = console.log;
    console.log = (...args) => calls.push(args);
    try {
      const bot = createTelegramBot({
        token: "",
        miniAppUrl: "http://localhost:3000",
        repository: repo,
        now: () => new Date(scenario.now),
        expenseParser: {
          async parse(text, options) {
            parserCalls.push({ text, options });
            return {
              expenses: [{
                amount: 70,
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

      for (const text of scenario.onboardingMessages) {
        await bot.handleUpdate(textUpdate(text, 100));
      }
      await bot.handleUpdate(textUpdate("coffee 70", 100));
      await bot.handleUpdate(textUpdate("/start", 100));
    } finally {
      console.log = originalLog;
    }

    assert.equal(repo.user.onboarding_step, "completed", scenario.name);
    assert.equal(parserCalls.length, 1, scenario.name);
    assert.equal(parserCalls[0].text, "coffee 70", scenario.name);
    assert.equal(repo.currentMonthBudget, null, scenario.name);
    assert.ok(calls.at(-1)[1].replyMarkup.inline_keyboard[0][0].web_app, scenario.name);
  }
});

test("current month budget can be skipped without creating a monthly override", async () => {
  for (const skipText of ["skip", "пропустить", "0"]) {
    const calls = [];
    const repo = fakeRepository();
    repo.user = {
      id: 1,
      interface_language: skipText === "пропустить" ? "ru" : "en",
      base_currency: "THB",
      monthly_budget_amount: 42000,
      onboarding_step: "current_month_budget",
      onboarding_data: {}
    };
    const originalLog = console.log;
    console.log = (...args) => calls.push(args);
    try {
      const bot = createTelegramBot({
        token: "",
        miniAppUrl: "http://localhost:3000",
        repository: repo,
        now: () => new Date("2026-06-12T10:00:00+07:00")
      });

      await bot.handleUpdate(textUpdate(skipText, 100));
    } finally {
      console.log = originalLog;
    }

    assert.equal(repo.user.onboarding_step, "completed", skipText);
    assert.equal(repo.currentMonthBudget, null, skipText);
    assert.equal(repo.setCurrentMonthBudgetCalls, 0, skipText);
    assert.match(calls[0][1].text, /setup is complete|Готово/i, skipText);
    assert.ok(calls[0][1].replyMarkup.inline_keyboard[0][0].web_app, skipText);
  }
});

test("daily reminder add button sends expense hint", async () => {
  const messages = [];
  const repo = fakeRepository();
  repo.user = { id: 1, interface_language: "en", timezone: "Asia/Bangkok", base_currency: "THB", onboarding_step: "completed" };
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate(callbackUpdate("daily_reminder:add", 100));

  assert.match(messages.at(-1).text, /Send an expense by text or voice/);
  assert.equal(repo.events.some((event) => event.eventName === "daily_reminder_clicked_add"), true);
});

test("daily reminder no-spending button marks local date and edits message", async () => {
  const messages = [];
  const repo = fakeRepository();
  repo.user = { id: 1, interface_language: "en", timezone: "Asia/Bangkok", base_currency: "THB", onboarding_step: "completed" };
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    now: () => new Date("2026-06-25T15:30:00Z"),
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate(callbackUpdate("daily_reminder:no_spending", 100));

  assert.deepEqual(repo.noSpendingMarks[0], { userId: 1, localDate: "2026-06-25", timezoneUsed: "Asia/Bangkok" });
  assert.match(messages.at(-1).text, /marked today as no spending/);
  assert.equal(repo.events.some((event) => event.eventName === "daily_reminder_clicked_no_spending"), true);
});

test("daily reminder disable button turns off future reminders", async () => {
  const messages = [];
  const repo = fakeRepository();
  repo.user = { id: 1, interface_language: "en", timezone: "Asia/Bangkok", base_currency: "THB", onboarding_step: "completed" };
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate(callbackUpdate("daily_reminder:disable", 100));

  assert.equal(repo.dailyEntryReminderEnabled, false);
  assert.match(messages.at(-1).text, /won’t send evening reminders/);
  assert.equal(repo.events.some((event) => event.eventName === "daily_reminder_disabled"), true);
});

test("text message does not call voice transcription during onboarding", async () => {
  const repo = fakeRepository();
  repo.user = { id: 1, interface_language: "en", base_currency: "THB", onboarding_step: "language", onboarding_data: {} };
  let transcribed = false;
  const originalLog = console.log;
  console.log = () => {};
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      voiceTranscriber: {
        isConfigured: () => true,
        transcribeTelegramVoice: async () => {
          transcribed = true;
          return "Russian";
        }
      }
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        text: "English",
        voice: { file_id: "voice-file-id", mime_type: "audio/ogg" }
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(transcribed, false);
  assert.equal(repo.user.interface_language, "en");
  assert.equal(repo.user.onboarding_step, "budget_setup");
});

test("new user onboarding from the 1st to 5th asks only for regular monthly budget", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.user = { id: 1, interface_language: "en", base_currency: "THB", onboarding_step: "base_currency" };
  const originalLog = console.log;
  console.log = (...args) => calls.push(args);
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      now: () => new Date("2026-06-05T10:00:00+07:00")
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
  } finally {
    console.log = originalLog;
  }

  assert.match(calls[0][1].text, /base currency/i);
  assert.match(calls[1][1].text, /plan to spend per month/i);
  assert.match(calls[2][1].text, /setup is complete/i);
  assert.equal(repo.settings.baseCurrency, "IDR");
  assert.equal(repo.settings.monthlyBudgetAmount, 20000);
  assert.equal(repo.currentMonthBudget, null);
});

test("new user onboarding after the 5th asks for a current month budget", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.user = { id: 1, interface_language: "en", base_currency: "THB", onboarding_step: "base_currency" };
  const originalLog = console.log;
  console.log = (...args) => calls.push(args);
  try {
    const bot = createTelegramBot({
      token: "",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      now: () => new Date("2026-06-12T10:00:00+07:00")
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
        text: "8000"
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.match(calls[2][1].text, /The month has already started/);
  assert.match(calls[2][1].text, /until the end of this month/);
  assert.match(calls[3][1].text, /setup is complete/i);
  assert.equal(repo.settings.monthlyBudgetAmount, 20000);
  assert.equal(repo.currentMonthBudget.amount, 8000);
  assert.equal(repo.currentMonthBudget.isPartialMonth, true);
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
  assert.match(calls[1][1].text, /Planned expense/i);
  assert.equal(calls[1][1].replyMarkup.inline_keyboard[0][0].callback_data, "plan_confirm:77");
  assert.equal(repo.confirmedPlannedDraftId, "77");
  assert.ok(repo.events.some((event) => event.eventName === "expense_draft_created" && event.metadata.draftType === "planned"));
  assert.ok(repo.events.some((event) => event.eventName === "expense_draft_confirmed" && event.metadata.draftType === "planned"));
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
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("draft category callback accepts a canonical slug, marks user source and edits in place", async () => {
  const calls = [];
  const repo = fakeRepository();
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: {
      async sendMessage(message) { calls.push({ method: "sendMessage", ...message }); return { ok: true }; },
      async editMessageText(message) { calls.push({ method: "editMessageText", ...message }); return { ok: true }; },
      async answerCallbackQuery(message) { calls.push({ method: "answerCallbackQuery", ...message }); return { ok: true }; },
      async deleteMessage() { return { ok: true }; }
    }
  });

  await bot.handleUpdate({
    callback_query: {
      id: "callback-d-cat",
      data: "d:42:c:groceries",
      from: { id: 100 },
      message: { chat: { id: 10 }, message_id: 71 }
    }
  });

  assert.equal(repo.updatedItems[0].category_slug, "groceries");
  assert.equal(repo.updatedItems[0].category_source, "user");
  const edit = calls.find((call) => call.method === "editMessageText");
  assert.ok(edit);
  assert.equal(edit.messageId, 71);
  assert.equal(calls.some((call) => call.method === "sendMessage"), false);
  assert.ok(calls.some((call) => call.method === "answerCallbackQuery"));
});

test("draft category callback keeps legacy food and sport callbacks working end to end", async (t) => {
  for (const [legacyCode, slug] of [["food", "food_cafe"], ["sport", "sport_activities"]]) {
    await t.test(legacyCode, async () => {
      const calls = [];
      const repo = fakeRepository();
      const bot = createTelegramBot({
        token: "test-token",
        miniAppUrl: "http://localhost:3000",
        repository: repo,
        telegramClient: capturingClient(calls)
      });

      await bot.handleUpdate(callbackUpdate(`d:42:c:${legacyCode}`, 100));

      assert.equal(repo.updatedItems[0].category_slug, slug);
      assert.ok(calls.some((call) => call.method === "editMessageText"));
    });
  }
});

test("draft callback redraw prepares a fresh mixed-currency total after the update", async () => {
  const calls = [];
  const previewItems = [];
  const repo = fakeRepository();
  repo.user = { ...repo.user, interface_language: "en", base_currency: "USD" };
  repo.getDraftForTelegramUser = async () => ({
    id: 42,
    status: "pending",
    items: [
      { amount: 10, currency: "USD", description: "coffee", category_slug: "other", spent_at: "2026-07-20T08:00:00.000Z" },
      { amount: 20, currency: "EUR", description: "lunch", category_slug: "other", spent_at: "2026-07-20T12:00:00.000Z" }
    ]
  });
  repo.prepareDraftPreview = async (items) => {
    previewItems.push(items);
    return { kind: "converted", baseCurrency: "USD", total: 33.75 };
  };
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: capturingClient(calls)
  });

  await bot.handleUpdate(callbackUpdate("d:42:c:food", 100));

  assert.equal(previewItems.length, 1);
  assert.equal(previewItems[0][0].category_slug, "food_cafe");
  const edit = calls.find((call) => call.method === "editMessageText");
  assert.ok(edit);
  assert.match(edit.text, /<b>Total:<\/b> 33\.75 USD/);
});

test("returning from the draft editor previews the latest amount, currency, and date data", async (t) => {
  const baseItems = [
    { amount: 10, currency: "USD", description: "coffee", category_slug: "food_cafe", spent_at: "2026-07-20T08:00:00.000Z" },
    { amount: 20, currency: "EUR", description: "lunch", category_slug: "food_cafe", spent_at: "2026-07-20T12:00:00.000Z" }
  ];
  const cases = [
    { name: "amount", items: [{ ...baseItems[0], amount: 15 }, baseItems[1]], total: 35.1 },
    { name: "currency", items: [baseItems[0], { ...baseItems[1], currency: "RUB" }], total: 36.2 },
    { name: "date", items: [baseItems[0], { ...baseItems[1], spent_at: "2026-07-19T12:00:00.000Z" }], total: 37.3 }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const calls = [];
      const previewCalls = [];
      const repo = fakeRepository();
      repo.user = { ...repo.user, interface_language: "en", base_currency: "USD" };
      repo.getDraftForTelegramUser = async () => ({ id: 42, status: "pending", items: scenario.items });
      repo.prepareDraftPreview = async (items, user) => {
        previewCalls.push({ items, user });
        return { kind: "converted", baseCurrency: "USD", total: scenario.total };
      };
      const bot = createTelegramBot({
        token: "test-token",
        miniAppUrl: "http://localhost:3000",
        repository: repo,
        telegramClient: capturingClient(calls)
      });

      await bot.handleUpdate(callbackUpdate("ee:d:42:0:back", 100));

      assert.deepEqual(previewCalls, [{ items: scenario.items, user: repo.user }]);
      const card = calls.find((call) => call.method === "sendMessage" && /<b>Total:<\/b>/.test(call.text));
      assert.ok(card);
      assert.match(card.text, new RegExp(`${scenario.total.toFixed(2).replace(".", "\\.")} USD`));
    });
  }
});

test("draft type callback (d: scheme) updates budget impact and edits in place", async () => {
  const calls = [];
  const repo = fakeRepository();
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: {
      async sendMessage(message) { calls.push({ method: "sendMessage", ...message }); return { ok: true }; },
      async editMessageText(message) { calls.push({ method: "editMessageText", ...message }); return { ok: true }; },
      async answerCallbackQuery(message) { calls.push({ method: "answerCallbackQuery", ...message }); return { ok: true }; },
      async deleteMessage() { return { ok: true }; }
    }
  });

  await bot.handleUpdate({
    callback_query: {
      id: "callback-d-type",
      data: "d:42:t:r",
      from: { id: 100 },
      message: { chat: { id: 10 }, message_id: 72 }
    }
  });

  assert.equal(repo.updatedItems[0].budget_impact, "regular");
  const edit = calls.find((call) => call.method === "editMessageText");
  assert.ok(edit);
  assert.equal(edit.messageId, 72);
});

test("draft type callback (d: scheme) only toasts when the selected impact is unchanged", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.getDraftForTelegramUser = async () => ({
    id: 42,
    status: "pending",
    items: [{ amount: 70, currency: "THB", description: "coffee", category_slug: "food_cafe", tags: [], budget_impact: "regular" }]
  });
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: repo, telegramClient: capturingClient(calls)
  });

  await bot.handleUpdate(callbackUpdate("d:42:t:r", 100));

  assert.equal(repo.updatedItems, null);
  assert.equal(calls.some((call) => call.method === "editMessageText"), false);
  assert.ok(calls.some((call) => call.method === "answerCallbackQuery" && /Уже выбрано|Already selected/.test(call.text)));
});

test("draft confirm callback (d: scheme) acknowledges saving and skips save events when alreadySaved", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.saveDraftAsExpense = async () => {
    return { expenses: [{ amount_base: 75 }], dashboardSnapshot: null, alreadySaved: true };
  };
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: {
      async sendMessage(message) { calls.push({ method: "sendMessage", ...message }); return { ok: true }; },
      async editMessageText(message) { calls.push({ method: "editMessageText", ...message }); return { ok: true }; },
      async answerCallbackQuery(message) { calls.push({ method: "answerCallbackQuery", ...message }); return { ok: true }; },
      async deleteMessage() { return { ok: true }; }
    }
  });

  await bot.handleUpdate({
    callback_query: {
      id: "callback-d-confirm-already",
      data: "d:42:confirm",
      from: { id: 100 },
      message: { chat: { id: 10 }, message_id: 73 }
    }
  });

  const answer = calls.find((call) => call.method === "answerCallbackQuery");
  assert.ok(answer);
  assert.equal(answer.text, "Сохраняю…");
  assert.equal(repo.events.some((event) => event.eventName === "expense_saved"), false);
  assert.equal(repo.events.some((event) => event.eventName === "expense_draft_confirmed"), false);
});

test("draft review callback (d: scheme) moves the draft to the inbox", async () => {
  let moved = null;
  const repo = fakeRepository();
  const moveSpy = repo.moveDraftToInbox.bind(repo);
  repo.moveDraftToInbox = async (draftId, telegramUserId) => {
    moved = { draftId, telegramUserId };
    return moveSpy(draftId, telegramUserId);
  };
  const messages = [];
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate({
    callback_query: {
      id: "callback-d-review",
      data: "d:42:review",
      from: { id: 100 },
      message: { chat: { id: 10 } }
    }
  });

  assert.deepEqual(moved, { draftId: "42", telegramUserId: 100 });
  assert.match(messages.at(-1).text, /Inbox/);
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

    const keyboard = calls[1][1].replyMarkup.inline_keyboard.flat();
    assert.ok(keyboard.some((button) => button.callback_data === "d:42:c:food_cafe"));
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

test("queued second message uses localized text for ru and en users", async () => {
  const cases = [
    {
      language: "ru",
      expected: "Принял ещё одно сообщение. Сначала закончу предыдущий расход, потом обработаю это."
    },
    {
      language: "en",
      expected: "Got one more message. I’ll finish the previous expense first, then process this one."
    }
  ];

  for (const { language, expected } of cases) {
    const messages = [];
    const parser = controlledExpenseParser();
    const repo = fakeRepository();
    repo.user = { id: 1, interface_language: language, base_currency: "THB", onboarding_step: "completed" };
    const bot = createTelegramBot({
      token: "test-token",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      expenseParser: parser,
      telegramClient: captureTelegramClient(messages),
      awaitQueuedJobs: false,
      telegramJobQueueOptions: {
        globalConcurrency: 1,
        userQueueLimit: 2,
        jobTimeoutMs: 10_000
      },
      perfLogger: () => {}
    });

    await bot.handleUpdate(textUpdate("first expense", 100));
    await bot.handleUpdate(textUpdate("second expense", 100));

    assert.ok(messages.some((message) => message.text === expected));
    await parser.waitForCalls(1);
    parser.resolveNext();
    await parser.waitForCalls(2);
    parser.resolveNext();
    await parser.waitForCalls(2);
  }
});

test("full user queue uses localized text for ru and en users", async () => {
  const cases = [
    {
      language: "ru",
      expected: "Я уже разбираю несколько твоих сообщений. Чтобы не перепутать расходы, дождись результата и отправь следующее чуть позже."
    },
    {
      language: "en",
      expected: "I’m already processing several of your messages. To avoid mixing up expenses, please wait for the result and send the next one a bit later."
    }
  ];

  for (const { language, expected } of cases) {
    const messages = [];
    const parser = controlledExpenseParser();
    const repo = fakeRepository();
    repo.user = { id: 1, interface_language: language, base_currency: "THB", onboarding_step: "completed" };
    const bot = createTelegramBot({
      token: "test-token",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      expenseParser: parser,
      telegramClient: captureTelegramClient(messages),
      awaitQueuedJobs: false,
      telegramJobQueueOptions: {
        globalConcurrency: 1,
        userQueueLimit: 2,
        jobTimeoutMs: 10_000
      },
      perfLogger: () => {}
    });

    await bot.handleUpdate(textUpdate("first expense", 100));
    await bot.handleUpdate(textUpdate("second expense", 100));
    await bot.handleUpdate(textUpdate("third expense", 100));
    await bot.handleUpdate(textUpdate("fourth expense", 100));

    assert.ok(messages.some((message) => message.text === expected));
    assert.equal(parser.callCount(), 1);
    await parser.waitForCalls(1);
    parser.resolveNext();
    await parser.waitForCalls(2);
    parser.resolveNext();
    await parser.waitForCalls(3);
    parser.resolveNext();
  }
});

test("admin release preview is denied to non-admin users", async () => {
  const messages = [];
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: fakeRepository(),
    adminTelegramIds: new Set([999]),
    releaseNotesService: fakeReleaseNotesService(),
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate({
    message: {
      chat: { id: 10 },
      from: { id: 100, first_name: "M" },
      text: "/admin_release_preview"
    }
  });

  assert.match(messages[0].text, /доступна только администратору/i);
});

test("admin release send is denied to non-admin users", async () => {
  const messages = [];
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: fakeRepository(),
    adminTelegramIds: new Set([999]),
    releaseNotesService: fakeReleaseNotesService(),
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate({
    message: {
      chat: { id: 10 },
      from: { id: 100, first_name: "M" },
      text: "/admin_release_send"
    }
  });

  assert.match(messages[0].text, /доступна только администратору/i);
});

test("admin release preview uses pending notes since the last digest", async () => {
  const messages = [];
  const calls = [];
  const now = new Date("2026-06-20T14:00:00Z");
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: fakeRepository(),
    adminTelegramIds: new Set([100]),
    releaseNotesService: fakeReleaseNotesService({
      calls,
      previewText: [
        "Пользователям будет отправлено:",
        "",
        "✨ Money Flow v.1.18",
        "",
        "Что изменилось сегодня:",
        "",
        "• Онбординг стал проще.",
        "",
        "Скрыто из пользовательского пуша:",
        "• admin: добавлена /admin_stats"
      ].join("\n")
    }),
    now: () => now,
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate({
    message: {
      chat: { id: 10 },
      from: { id: 100, first_name: "M" },
      text: "/admin_release_preview@MoneyFlowBot"
    }
  });

  assert.deepEqual(calls, [{ method: "preview", now }]);
  assert.match(messages[0].text, /Пользователям будет отправлено/);
  assert.match(messages[0].text, /Скрыто из пользовательского пуша/);
});

test("admin release send uses manual trigger and returns a range summary", async () => {
  const messages = [];
  const calls = [];
  const now = new Date("2026-06-20T14:00:00Z");
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: fakeRepository(),
    adminTelegramIds: new Set([100]),
    releaseNotesService: fakeReleaseNotesService({
      calls,
      sendResult: {
        sent: true,
        versionFrom: "v.1.18",
        versionTo: "v.1.20",
        users: 12,
        success: 11,
        errors: 1,
        skipped: 2,
        blocked: 1
      }
    }),
    now: () => now,
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate({
    message: {
      chat: { id: 10 },
      from: { id: 100, first_name: "M" },
      text: "/admin_release_send@MoneyFlowBot"
    }
  });

  assert.deepEqual(calls, [{ method: "send", now, options: { trigger: "manual" } }]);
  assert.match(messages[0].text, /Release digest отправлен/);
  assert.match(messages[0].text, /Версии: v\.1\.18 — v\.1\.20/);
  assert.match(messages[0].text, /Пользователей: 12/);
  assert.match(messages[0].text, /Пропущено: 2/);
  assert.match(messages[0].text, /Заблокировали бота: 1/);
  assert.doesNotMatch(messages[0].text, /undefined/);
});

test("admin release send reports empty public user notes", async () => {
  const messages = [];
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: fakeRepository(),
    adminTelegramIds: new Set([100]),
    releaseNotesService: fakeReleaseNotesService({
      sendResult: { sent: false, reason: "no_public_release_notes" }
    }),
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate({
    message: {
      chat: { id: 10 },
      from: { id: 100, first_name: "M" },
      text: "/admin_release_send"
    }
  });

  assert.equal(messages[0].text, "Нет новых публичных изменений для пользователей с прошлого дайджеста — отправлять нечего.");
});

test("admin release send reports when there are no active release push users", async () => {
  const messages = [];
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: fakeRepository(),
    adminTelegramIds: new Set([100]),
    releaseNotesService: fakeReleaseNotesService({
      sendResult: { sent: false, reason: "no_active_release_push_users", users: 0 }
    }),
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate({
    message: {
      chat: { id: 10 },
      from: { id: 100, first_name: "M" },
      text: "/admin_release_send"
    }
  });

  assert.equal(messages[0].text, "Нет активных пользователей для release push — digest не был отправлен.");
  assert.doesNotMatch(messages[0].text, /Release digest отправлен/);
  assert.doesNotMatch(messages[0].text, /Пользователей: 0/);
});

test("admin release send reports an in-progress digest without a success summary", async () => {
  const messages = [];
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: fakeRepository(),
    adminTelegramIds: new Set([100]),
    releaseNotesService: fakeReleaseNotesService({
      sendResult: { sent: false, reason: "digest_already_running" }
    }),
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate({
    message: {
      chat: { id: 10 },
      from: { id: 100, first_name: "M" },
      text: "/admin_release_send"
    }
  });

  assert.equal(messages[0].text, "Release digest уже выполняется — повторный запуск не нужен.");
  assert.doesNotMatch(messages[0].text, /отправлен/);
});

test("admin release send reports a duplicate automatic run without a success summary", async () => {
  const messages = [];
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: fakeRepository(),
    adminTelegramIds: new Set([100]),
    releaseNotesService: fakeReleaseNotesService({
      sendResult: { sent: false, reason: "duplicate_auto_run" }
    }),
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate({
    message: {
      chat: { id: 10 },
      from: { id: 100, first_name: "M" },
      text: "/admin_release_send"
    }
  });

  assert.equal(messages[0].text, "Release digest уже выполняется — повторный запуск не нужен.");
  assert.doesNotMatch(messages[0].text, /отправлен/);
});

test("command menus hide technical commands in English and Russian", () => {
  const enCommands = buildTelegramCommandMenu();
  const ruCommands = buildTelegramCommandMenu("ru");

  for (const commands of [enCommands, ruCommands]) {
    assert.equal(commands.some((command) => ["app", "settings", "delete_me"].includes(command.command)), false);
  }
});

test("/delete_me restarts a pending Telegram account deletion request with warning buttons", async () => {
  const messages = [];
  const repo = fakeRepository();
  repo.user = { ...repo.user, interface_language: "en" };
  repo.pendingAccountDeletion = { status: "pending", stage: "awaiting_text", source: "telegram" };
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate(textUpdate("/delete_me", 100));

  assert.deepEqual(repo.accountDeletionRequests, [{ telegramUserId: 100, options: { source: "telegram" } }]);
  assert.equal(repo.accountDeletionAdvances.length, 0);
  assert.equal(repo.accountDeletionConfirms.length, 0);
  assert.match(messages[0].text, /permanently deletes/i);
  assert.deepEqual(messages[0].replyMarkup.inline_keyboard[0].map((button) => button.callback_data), [
    "delete_me:advance",
    "delete_me:cancel"
  ]);
});

test("delete_me advance asks for exact DELETE and keeps cancel button", async () => {
  const messages = [];
  const repo = fakeRepository();
  repo.user = { ...repo.user, interface_language: "en" };
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate(callbackUpdate("delete_me:advance", 100));

  assert.deepEqual(repo.accountDeletionAdvances, [{ telegramUserId: 100, options: { source: "telegram" } }]);
  assert.equal(repo.accountDeletionConfirms.length, 0);
  assert.match(messages[0].text, /DELETE/);
  assert.deepEqual(messages[0].replyMarkup.inline_keyboard, [[
    { text: "Cancel", callback_data: "delete_me:cancel" }
  ]]);
});

test("delete_me cancel cancels Telegram account deletion without deleting data", async () => {
  const messages = [];
  const repo = fakeRepository();
  repo.user = { ...repo.user, interface_language: "en" };
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate(callbackUpdate("delete_me:cancel", 100));

  assert.deepEqual(repo.accountDeletionCancels, [{ telegramUserId: 100, options: { source: "telegram" } }]);
  assert.equal(repo.accountDeletionConfirms.length, 0);
  assert.match(messages[0].text, /nothing was deleted/i);
});

test("Telegram account deletion warning and buttons are localized in Russian", async () => {
  const messages = [];
  const repo = fakeRepository();
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate(textUpdate("/delete_me", 100));

  assert.match(messages[0].text, /безвозвратно удалит/i);
  assert.deepEqual(messages[0].replyMarkup.inline_keyboard[0], [
    { text: "Продолжить", callback_data: "delete_me:advance" },
    { text: "Отмена", callback_data: "delete_me:cancel" }
  ]);
});

test("Telegram account deletion DELETE prompt is localized in Russian", async () => {
  const messages = [];
  const repo = fakeRepository();
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate(callbackUpdate("delete_me:advance", 100));

  assert.match(messages[0].text, /Введите DELETE/i);
  assert.deepEqual(messages[0].replyMarkup.inline_keyboard, [[
    { text: "Отмена", callback_data: "delete_me:cancel" }
  ]]);
});

test("expired delete_me advance callback returns a localized restart message", async () => {
  const messages = [];
  const repo = fakeRepository();
  repo.user = { ...repo.user, interface_language: "en" };
  repo.advanceAccountDeletion = async () => null;
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: captureTelegramClient(messages)
  });

  await assert.doesNotReject(() => bot.handleUpdate(callbackUpdate("delete_me:advance", 100)));

  assert.equal(repo.accountDeletionConfirms.length, 0);
  assert.match(messages[0].text, /expired/i);
  assert.match(messages[0].text, /\/delete_me/);
});

test("pending DELETE confirms before parser queue and final message has no app keyboard", async () => {
  const messages = [];
  const repo = fakeRepository();
  repo.user = { ...repo.user, interface_language: "en" };
  const queueCalls = [];
  const parserCalls = [];
  repo.pendingAccountDeletion = { status: "pending", stage: "awaiting_text", source: "telegram" };
  const now = new Date("2026-07-09T10:00:00.000Z");
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: captureTelegramClient(messages),
    now: () => now,
    telegramJobQueue: {
      enqueue(job) {
        queueCalls.push(job);
        return { accepted: true, status: "started", stats: {}, promise: Promise.resolve() };
      }
    },
    expenseParser: {
      async parse() {
        parserCalls.push("parse");
        return { expenses: [], notes: [] };
      }
    }
  });

  await bot.handleUpdate(textUpdate("DELETE", 100));

  assert.deepEqual(repo.accountDeletionPendingLookups, [{ telegramUserId: 100, options: { source: "telegram", now } }]);
  assert.deepEqual(repo.accountDeletionConfirms, [{
    telegramUserId: 100,
    source: "telegram",
    confirmationText: "DELETE",
    now
  }]);
  assert.equal(queueCalls.length, 0);
  assert.equal(parserCalls.length, 0);
  assert.equal(repo.events.some((event) => event.eventName === "message_received"), false);
  assert.match(messages[0].text, /data has been deleted/i);
  assert.equal(messages[0].replyMarkup?.keyboard, undefined);
  assert.equal(messages[0].replyMarkup?.inline_keyboard, undefined);
});

test("expired pending DELETE confirmation is handled without parser or queue", async () => {
  const messages = [];
  const repo = fakeRepository();
  repo.user = { ...repo.user, interface_language: "en" };
  const queueCalls = [];
  repo.pendingAccountDeletion = { status: "pending", stage: "awaiting_text", source: "telegram" };
  repo.confirmAccountDeletion = async (args) => {
    repo.accountDeletionConfirms.push(args);
    const error = new Error("expired");
    error.code = "account_deletion_expired";
    throw error;
  };
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: captureTelegramClient(messages),
    telegramJobQueue: {
      enqueue(job) {
        queueCalls.push(job);
        return { accepted: true, status: "started", stats: {}, promise: Promise.resolve() };
      }
    }
  });

  await assert.doesNotReject(() => bot.handleUpdate(textUpdate("DELETE", 100)));

  assert.equal(repo.accountDeletionConfirms.length, 1);
  assert.equal(queueCalls.length, 0);
  assert.equal(repo.events.some((event) => event.eventName === "message_received"), false);
  assert.match(messages[0].text, /expired or is no longer pending/i);
});

test("wrong text during pending deletion does not reach parser or queue", async () => {
  const messages = [];
  const repo = fakeRepository();
  repo.user = { ...repo.user, interface_language: "en" };
  const queueCalls = [];
  const parserCalls = [];
  repo.pendingAccountDeletion = { status: "pending", stage: "awaiting_text", source: "telegram" };
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: captureTelegramClient(messages),
    telegramJobQueue: {
      enqueue(job) {
        queueCalls.push(job);
        return { accepted: true, status: "started", stats: {}, promise: Promise.resolve() };
      }
    },
    expenseParser: {
      async parse() {
        parserCalls.push("parse");
        return { expenses: [], notes: [] };
      }
    }
  });

  await bot.handleUpdate(textUpdate("delete", 100));

  assert.equal(repo.accountDeletionConfirms.length, 0);
  assert.equal(queueCalls.length, 0);
  assert.equal(parserCalls.length, 0);
  assert.equal(repo.events.some((event) => event.eventName === "message_received"), false);
  assert.match(messages[0].text, /Type DELETE to confirm or \/delete_me to start again\./);
});

for (const { name, message } of [
  { name: "voice", message: { voice: { file_id: "voice-file-id", mime_type: "audio/ogg" } } },
  { name: "photo", message: { photo: [{ file_id: "photo-file-id" }] } },
  { name: "unsupported", message: { sticker: { file_id: "sticker-file-id" } } }
]) {
  test(`pending deletion blocks ${name} input before events, queue, parser, and transcription`, async () => {
    const messages = [];
    const repo = fakeRepository();
    repo.user = { ...repo.user, interface_language: "en" };
    const queueCalls = [];
    const parserCalls = [];
    const transcriberCalls = [];
    repo.pendingAccountDeletion = { status: "pending", stage: "awaiting_text", source: "telegram" };
    const bot = createTelegramBot({
      token: "test-token",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      telegramClient: captureTelegramClient(messages),
      telegramJobQueue: {
        enqueue(job) {
          queueCalls.push(job);
          return { accepted: true, status: "started", stats: {}, promise: Promise.resolve() };
        }
      },
      expenseParser: {
        async parse() {
          parserCalls.push("parse");
          return { expenses: [], notes: [] };
        }
      },
      voiceTranscriber: {
        isConfigured: () => true,
        async transcribeTelegramVoice() {
          transcriberCalls.push("transcribe");
          return "coffee 70 baht";
        }
      }
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 10 },
        from: { id: 100, first_name: "M" },
        ...message
      }
    });

    assert.equal(repo.accountDeletionPendingLookups.length, 1);
    assert.equal(repo.accountDeletionConfirms.length, 0);
    assert.equal(queueCalls.length, 0);
    assert.equal(parserCalls.length, 0);
    assert.equal(transcriberCalls.length, 0);
    assert.equal(repo.events.some((event) => event.eventName === "message_received"), false);
    assert.match(messages[0].text, /Type DELETE to confirm or \/delete_me to start again\./);
  });
}

test("final deletion message failure is best-effort after Telegram account deletion commits", async () => {
  const repo = fakeRepository();
  const queueCalls = [];
  const parserCalls = [];
  const adminAlerts = [];
  const errorLogs = [];
  const originalError = console.error;
  repo.pendingAccountDeletion = { status: "pending", stage: "awaiting_text", source: "telegram" };
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: {
      async sendMessage() {
        throw new Error("send failed for chat 10 user 100 with DELETE");
      }
    },
    telegramJobQueue: {
      enqueue(job) {
        queueCalls.push(job);
        return { accepted: true, status: "started", stats: {}, promise: Promise.resolve() };
      }
    },
    expenseParser: {
      async parse() {
        parserCalls.push("parse");
        return { expenses: [], notes: [] };
      }
    },
    adminAlertService: {
      async notifyAdminError(...args) {
        adminAlerts.push(args);
      }
    }
  });

  console.error = (...args) => errorLogs.push(args);
  try {
    await assert.doesNotReject(() => bot.handleUpdate(textUpdate("DELETE", 100)));
  } finally {
    console.error = originalError;
  }

  assert.equal(repo.accountDeletionConfirms.length, 1);
  assert.equal(queueCalls.length, 0);
  assert.equal(parserCalls.length, 0);
  assert.equal(repo.events.some((event) => event.eventName === "message_received"), false);
  assert.equal(adminAlerts.length, 0);
  assert.deepEqual(errorLogs, [["[telegram] failed to send account deletion completion message"]]);
});

test("unrelated command during pending deletion sends guidance before command handling", async () => {
  const messages = [];
  const repo = fakeRepository();
  repo.user = { ...repo.user, interface_language: "en" };
  const queueCalls = [];
  const parserCalls = [];
  let dashboardCalls = 0;
  repo.pendingAccountDeletion = { status: "pending", stage: "awaiting_text", source: "telegram" };
  repo.dashboard = async () => {
    dashboardCalls += 1;
    return { snapshot: {} };
  };
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: captureTelegramClient(messages),
    telegramJobQueue: {
      enqueue(job) {
        queueCalls.push(job);
        return { accepted: true, status: "started", stats: {}, promise: Promise.resolve() };
      }
    },
    expenseParser: {
      async parse() {
        parserCalls.push("parse");
        return { expenses: [], notes: [] };
      }
    }
  });

  await bot.handleUpdate(textUpdate("/today", 100));

  assert.equal(dashboardCalls, 0);
  assert.equal(queueCalls.length, 0);
  assert.equal(parserCalls.length, 0);
  assert.equal(repo.events.some((event) => event.eventName === "message_received"), false);
  assert.match(messages[0].text, /Type DELETE to confirm or \/delete_me to start again\./);
});

test("DELETE without pending deletion does not confirm and flows normally", async () => {
  const messages = [];
  const repo = fakeRepository();
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate(textUpdate("DELETE", 100));

  assert.equal(repo.accountDeletionConfirms.length, 0);
  assert.ok(repo.events.some((event) => event.eventName === "message_received"));
});

function fakeRepository() {
  return {
    user: { id: 1, interface_language: "ru", onboarding_step: "completed" },
    events: [],
    confirmedDraftId: null,
    confirmedPlannedDraftId: null,
    updatedItems: null,
    markedReportKey: null,
    settings: {},
    monthBaseline: null,
    currentMonthBudget: null,
    noSpendingMarks: [],
    dailyEntryReminderEnabled: true,
    setCurrentMonthBudgetCalls: 0,
    plannedDraft: null,
    accountDeletionRequests: [],
    accountDeletionAdvances: [],
    accountDeletionCancels: [],
    accountDeletionConfirms: [],
    accountDeletionPendingLookups: [],
    pendingAccountDeletion: null,
    savedDraftIds: new Set(),
    draftItems: [],
    async upsertTelegramUser() {
      return this.user;
    },
    async getUserByTelegramId() {
      return this.user;
    },
    async recordAppEvent(userId, eventName, metadata = {}) {
      this.events.push({ userId, eventName, metadata });
    },
    async recordAppEventOnce(userId, eventName, metadata = {}) {
      if (!this.events.some((event) => event.userId === userId && event.eventName === eventName)) {
        this.events.push({ userId, eventName, metadata });
        return { recorded: true };
      }
      return { recorded: false };
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
    async updateOnboardingLanguage(telegramUserId, language) {
      this.user = { ...this.user, interface_language: language, onboarding_step: "budget_setup", onboarding_data: {} };
      return this.user;
    },
    async updateOnboardingData(_telegramUserId, data) {
      this.user = { ...this.user, onboarding_data: data };
      return this.user;
    },
    async completeOnboardingBudgetSetup(_telegramUserId, settings) {
      this.settings = {
        ...this.settings,
        baseCurrency: settings.baseCurrency,
        monthlyBudgetAmount: settings.monthlyBudgetAmount
      };
      this.user = {
        ...this.user,
        base_currency: settings.baseCurrency,
        monthly_budget_amount: settings.monthlyBudgetAmount,
        onboarding_step: settings.nextStep,
        onboarding_data: {}
      };
      return this.user;
    },
    async setMonthBaseline(_telegramUserId, baseline) {
      this.monthBaseline = baseline;
      return baseline;
    },
    async setCurrentMonthBudget(_telegramUserId, budget) {
      this.setCurrentMonthBudgetCalls += 1;
      this.currentMonthBudget = budget;
      this.user = { ...this.user, onboarding_step: "completed" };
      return budget;
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
    async cancelDraft() {
      return { canceled: true };
    },
    async createDraft(_userId, _sourceText, items) {
      this.draftItems = items;
      return { id: 42 };
    },
    async setDraftMessageRef() {
      return null;
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
    async saveDraftAsExpense(draftId) {
      this.confirmedDraftId = draftId;
      const alreadySaved = this.savedDraftIds.has(String(draftId));
      this.savedDraftIds.add(String(draftId));
      const item = this.draftItems[0] ?? {};
      return {
        expenses: [{
          id: 1,
          draft_id: draftId,
          amount_base: Number(item.amount ?? 75),
          amount_original: Number(item.amount ?? 75),
          currency_original: item.currency ?? "THB",
          description: item.description ?? "expense",
          category_slug: item.category_slug ?? "other"
        }],
        dashboardSnapshot: (await this.dashboard()).snapshot,
        alreadySaved
      };
    },
    async confirmDraftWithExplicitAcceptance(draftId) {
      return this.saveDraftAsExpense(draftId);
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
    async createNoSpendingMark(userId, localDate, timezoneUsed) {
      this.noSpendingMarks.push({ userId, localDate, timezoneUsed });
    },
    async setDailyEntryReminderEnabled(_telegramUserId, enabled) {
      this.dailyEntryReminderEnabled = enabled;
      this.user = { ...this.user, daily_entry_reminder_enabled: enabled };
      return this.user;
    },
    async recordAppEvent(userId, eventName, metadata) {
      this.events.push({ userId, eventName, metadata });
    },
    async requestAccountDeletion(telegramUserId, options) {
      this.accountDeletionRequests.push({ telegramUserId, options });
      return { status: "pending", stage: "requested", source: options.source };
    },
    async advanceAccountDeletion(telegramUserId, options) {
      this.accountDeletionAdvances.push({ telegramUserId, options });
      return { status: "pending", stage: "awaiting_text", source: options.source };
    },
    async cancelAccountDeletion(telegramUserId, options) {
      this.accountDeletionCancels.push({ telegramUserId, options });
      return { status: "cancelled" };
    },
    async getPendingAccountDeletion(telegramUserId, options) {
      this.accountDeletionPendingLookups.push({ telegramUserId, options });
      return this.pendingAccountDeletion;
    },
    async confirmAccountDeletion(args) {
      this.accountDeletionConfirms.push(args);
      return { status: "deleted" };
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

function captureTelegramClient(messages) {
  return {
    async sendMessage(message) {
      messages.push(message);
      return { ok: true };
    },
    async editMessageText(message) {
      messages.push(message);
      return { ok: true };
    },
    async answerCallbackQuery() {
      return { ok: true };
    },
    async deleteMessage() {
      return { ok: true };
    },
    async setMyCommands() {
      return { ok: true };
    },
    async setChatMenuButton() {
      return { ok: true };
    }
  };
}

function textUpdate(text, telegramUserId) {
  return {
    message: {
      chat: { id: 10 },
      from: { id: telegramUserId, first_name: "M" },
      text
    }
  };
}

function callbackUpdate(data, telegramUserId) {
  return {
    callback_query: {
      id: "callback-1",
      data,
      from: { id: telegramUserId },
      message: { chat: { id: 10 }, message_id: 20 }
    }
  };
}

function controlledExpenseParser() {
  const pending = [];
  let calls = 0;
  let waiters = [];

  return {
    model: "test-model",
    async parse() {
      calls += 1;
      notifyWaiters();
      return new Promise((resolve) => {
        pending.push(() => resolve({
          expenses: [{
            amount: 70,
            currency: "THB",
            description: "coffee",
            category_slug: "food_cafe",
            tags: [],
            spent_at: "2026-06-02T10:00:00+07:00",
            confidence: 0.9,
            needs_review: false
          }]
        }));
      });
    },
    resolveNext() {
      pending.shift()?.();
    },
    callCount() {
      return calls;
    },
    waitForCalls(expected) {
      if (calls >= expected) return Promise.resolve();
      return new Promise((resolve) => {
        waiters.push({ expected, resolve });
      });
    }
  };

  function notifyWaiters() {
    const ready = waiters.filter((waiter) => calls >= waiter.expected);
    waiters = waiters.filter((waiter) => calls < waiter.expected);
    for (const waiter of ready) waiter.resolve();
  }
}

function fakeReleaseNotesService(options = {}) {
  return {
    async previewReleaseDigestSinceLastRun(now) {
      options.calls?.push({ method: "preview", now });
      return {
        text: options.previewText ?? "Сегодня нет release notes — пуш пользователям отправляться не будет."
      };
    },
    async sendReleaseDigestSinceLastRun(now, sendOptions) {
      options.calls?.push({ method: "send", now, options: sendOptions });
      return options.sendResult ?? {
        sent: false,
        reason: "no_public_release_notes"
      };
    }
  };
}

function emptyAdminPeriod(overrides = {}) {
  return {
    activeUsers: 0,
    newUsers: 0,
    messagesTotal: 0,
    textMessages: 0,
    voiceMessages: 0,
    photoMessages: 0,
    expensesSaved: 0,
    draftsCreated: 0,
    draftsConfirmed: 0,
    draftsCancelled: 0,
    parseFailed: 0,
    transcriptionFailed: 0,
    avgTextProcessingSeconds: null,
    avgVoiceProcessingSeconds: null,
    confirmRate: null,
    parseFailedRate: null,
    ...overrides
  };
}

function emptyProductPeriod(overrides = {}) {
  return {
    activeUsers: 0, newUsers: 0, expensesSaved: 0, expensesPerActiveUser: null,
    draftsCreated: 0, draftsConfirmed: 0, confirmRate: null, feedbackSent: 0,
    newlyBlocked: 0, newlyUnblocked: 0, deletedAccounts: 0, activeTwoDays: 0,
    activeThreeDays: 0, ...overrides
  };
}

function emptyProductAdminStats(overrides = {}) {
  const period = emptyProductPeriod();
  return {
    userBase: { reachableNow: 0, blockedNow: 0, deletedAllTime: 0, allTimeJoined: 0 },
    periods: { today: period, last3Days: period, last7Days: period, last30Days: period },
    funnel: { started: 0, onboardingStarted: 0, onboardingCompleted: 0, firstDraftCreated: 0, firstExpenseSaved: 0, dashboardOpened: 0 },
    activation: { medianHours: null },
    retention: { d1Eligible: 0, d1Returned: 0, d1Rate: null, d7Eligible: 0, d7Returned: 0, d7Rate: null },
    habit: { eligible: 0, started: 0, rate: null },
    reports: { deliveredUsers: 0, clickedUsers: 0, failedAttempts: 0, ctr: null },
    sources: [],
    health: { parseFailed: 0, parseFailedRate: null, transcriptionFailed: 0, p95TextSeconds: null, p95VoiceSeconds: null },
    ...overrides
  };
}

test("isMessageNotModified detects the not-modified 400 and rejects other errors", async () => {
  const { isMessageNotModified } = await import("../src/telegram.js");
  assert.equal(isMessageNotModified({ status: 400, body: "Bad Request: message is not modified" }), true);
  assert.equal(isMessageNotModified({ status: 400, body: "Bad Request: chat not found" }), false);
  assert.equal(isMessageNotModified({ status: 500, message: "message is not modified" }), false);
  assert.equal(isMessageNotModified(null), false);
});

test("regular draft delivery stores the originating telegram chat and message id", async () => {
  const refs = [];
  const repository = {
    async getUserByTelegramId() {
      return { id: 1, interface_language: "en", base_currency: "THB", onboarding_step: "completed" };
    },
    async createDraft() {
      return { id: 1, status: "pending" };
    },
    async createPlannedDraft() {
      return { id: 99 };
    },
    async setDraftMessageRef(draftId, _telegramUserId, chatId, messageId) {
      refs.push({ id: draftId, chatId, messageId });
    }
  };
  const expenseParser = {
    async parse() {
      return {
        expenses: [{
          amount: 70,
          currency: "THB",
          description: "coffee",
          category_slug: "food_cafe",
          budget_impact: "regular",
          needs_review: true,
          category_source: "parser",
          tags: [],
          spent_at: "2026-06-25T10:00:00Z"
        }]
      };
    }
  };
  const telegramClient = {
    async sendMessage() {
      return { ok: true, result: { message_id: 777 } };
    },
    async editMessageText() {
      return { ok: true, result: { message_id: 777 } };
    }
  };

  await processQueuedMessage({
    message: { chat: { id: 5 } },
    from: { id: 100 },
    user: { interface_language: "en", base_currency: "THB", onboarding_step: "completed" },
    rawText: "coffee 70",
    repository,
    token: null,
    miniAppUrl: "http://x",
    expenseParser,
    telegramClient,
    now: () => new Date(),
    trace: stubTrace()
  });

  assert.equal(refs.length, 1);
  assert.equal(refs[0].chatId, 5);
  assert.equal(refs[0].messageId, 777);
});

test("expense processing loader uses the selected custom emoji and replies to the source message in RU and EN", async () => {
  const cases = [
    { language: "ru", rawText: "переведи 1000", expectedText: '<tg-emoji emoji-id="6003518287214808258">🎲</tg-emoji> Заношу расход…' },
    { language: "en", rawText: "transfer 1000", expectedText: '<tg-emoji emoji-id="6003518287214808258">🎲</tg-emoji> Adding expense…' }
  ];

  for (const { language, rawText, expectedText } of cases) {
    const calls = [];
    await processQueuedMessage({
      message: { chat: { id: 5 }, message_id: 321 },
      from: { id: 100 },
      user: { id: 1, interface_language: language, base_currency: "THB", onboarding_step: "completed", timezone: "Asia/Bangkok" },
      rawText,
      inputType: "text",
      repository: { async recordAppEvent() {} },
      token: null,
      miniAppUrl: "http://x",
      expenseParser: { async parse() { throw new Error("expense parser should not be called"); } },
      telegramClient: {
        async sendMessage(message) {
          calls.push({ method: "sendMessage", ...message });
          return { ok: true, result: { message_id: 777 } };
        },
        async editMessageText(message) {
          calls.push({ method: "editMessageText", ...message });
          return { ok: true, result: { message_id: 777 } };
        }
      },
      now: () => new Date("2026-06-30T10:00:00Z"),
      trace: stubTrace()
    });

    assert.deepEqual(calls[0], {
      method: "sendMessage",
      chatId: 5,
      text: expectedText,
      replyMarkup: null,
      replyParameters: { message_id: 321, allow_sending_without_reply: true }
    });
  }
});

test("processQueuedMessage creates budget top-up draft before expense parser", async () => {
  let topupDraft = null;
  let expenseParserCalled = false;
  const repository = {
    async createBudgetTopupDraft(userId, sourceText, item) {
      topupDraft = { userId, sourceText, item };
      return { id: 42, status: "pending", item };
    },
    async previewBudgetTopup() {
      return { amountBase: 10000, baseBudget: 48000, large: false, monthKey: "2026-06" };
    },
    async recordAppEvent() {}
  };
  const expenseParser = {
    async parse() {
      expenseParserCalled = true;
      return { expenses: [] };
    }
  };
  const sent = [];
  const telegramClient = {
    async sendMessage(message) {
      sent.push(message);
      return { ok: true, result: { message_id: 777 } };
    },
    async editMessageText(message) {
      sent.push(message);
      return { ok: true, result: { message_id: 777 } };
    }
  };

  await processQueuedMessage({
    message: { chat: { id: 5 } },
    from: { id: 100 },
    user: { id: 1, interface_language: "en", base_currency: "THB", onboarding_step: "completed", timezone: "Asia/Bangkok" },
    rawText: "bonus 10000",
    inputType: null,
    repository,
    token: null,
    miniAppUrl: "http://x",
    expenseParser,
    telegramClient,
    now: () => new Date("2026-06-30T10:00:00Z"),
    trace: stubTrace()
  });

  assert.equal(expenseParserCalled, false);
  assert.equal(topupDraft.userId, 1);
  assert.equal(topupDraft.item.amount, 10000);
  assert.equal(topupDraft.item.kind, "income");
  assert.ok(sent.some((message) => String(message.text).includes("Budget top-up")));
});

test("processQueuedMessage routes new budget top-up phrasing before expense parser", async () => {
  const topupTexts = ["пополнение бюджета 500", "положил в бюджет 500", "put 500 into budget"];

  for (const rawText of topupTexts) {
    let topupDraft = null;
    let expenseParserCalled = false;
    const repository = {
      async createBudgetTopupDraft(userId, sourceText, item) {
        topupDraft = { userId, sourceText, item };
        return { id: 42, status: "pending", item };
      },
      async previewBudgetTopup() {
        return { amountBase: 500, baseBudget: 48000, large: false, monthKey: "2026-06" };
      },
      async recordAppEvent() {}
    };

    await processQueuedMessage({
      message: { chat: { id: 5 } },
      from: { id: 100 },
      user: { id: 1, interface_language: "ru", base_currency: "THB", onboarding_step: "completed", timezone: "Asia/Bangkok" },
      rawText,
      inputType: "text",
      repository,
      token: null,
      miniAppUrl: "http://x",
      expenseParser: {
        async parse() {
          expenseParserCalled = true;
          return { expenses: [] };
        }
      },
      telegramClient: {
        async sendMessage() { return { ok: true, result: { message_id: 777 } }; },
        async editMessageText() { return { ok: true, result: { message_id: 777 } }; }
      },
      now: () => new Date("2026-06-30T10:00:00Z"),
      trace: stubTrace()
    });

    assert.equal(expenseParserCalled, false, rawText);
    assert.equal(topupDraft.sourceText, rawText);
    assert.equal(topupDraft.item.amount, 500);
  }
});

test("processQueuedMessage sends non-expense guard message before expense parser", async () => {
  let createDraftCalled = false;
  let expenseParserCalled = false;
  const events = [];
  const sent = [];
  const repository = {
    async recordAppEvent(userId, eventName, metadata = {}) {
      events.push({ userId, eventName, metadata });
    },
    async createDraft() {
      createDraftCalled = true;
      return { id: 42 };
    }
  };

  await processQueuedMessage({
    message: { chat: { id: 5 } },
    from: { id: 100 },
    user: { id: 1, interface_language: "ru", base_currency: "THB", onboarding_step: "completed", timezone: "Asia/Bangkok" },
    rawText: "переведи 1000",
    inputType: "text",
    repository,
    token: null,
    miniAppUrl: "http://x",
    expenseParser: {
      async parse() {
        expenseParserCalled = true;
        return { expenses: [{ amount: 1000, currency: "THB", description: "transfer", category_slug: "other" }] };
      }
    },
    telegramClient: {
      async sendMessage(message) {
        sent.push(message);
        return { ok: true, result: { message_id: 777 } };
      },
      async editMessageText(message) {
        sent.push(message);
        return { ok: true, result: { message_id: 777 } };
      }
    },
    now: () => new Date("2026-06-30T10:00:00Z"),
    trace: stubTrace()
  });

  assert.equal(expenseParserCalled, false);
  assert.equal(createDraftCalled, false);
  assert.ok(sent.some((message) => String(message.text).includes("не обычный расход")));
  assert.ok(events.some((event) => event.eventName === "message_processing_completed"
    && event.metadata.result === "unsupported_intent_message"
    && event.metadata.parserRoute === "non_expense_guard"));
  assert.equal(events.some((event) => event.eventName === "expense_draft_created"), false);
});

test("processQueuedMessage guard covers English transfer and cash withdrawal intents", async () => {
  for (const rawText of ["transfer 1000", "снял со счета 1000"]) {
    let expenseParserCalled = false;
    let createDraftCalled = false;
    const sent = [];
    await processQueuedMessage({
      message: { chat: { id: 5 } },
      from: { id: 100 },
      user: { id: 1, interface_language: "en", base_currency: "THB", onboarding_step: "completed", timezone: "Asia/Bangkok" },
      rawText,
      inputType: "text",
      repository: {
        async recordAppEvent() {},
        async createDraft() {
          createDraftCalled = true;
          return { id: 42 };
        }
      },
      token: null,
      miniAppUrl: "http://x",
      expenseParser: {
        async parse() {
          expenseParserCalled = true;
          return { expenses: [] };
        }
      },
      telegramClient: {
        async sendMessage(message) {
          sent.push(message);
          return { ok: true, result: { message_id: 777 } };
        },
        async editMessageText(message) {
          sent.push(message);
          return { ok: true, result: { message_id: 777 } };
        }
      },
      now: () => new Date("2026-06-30T10:00:00Z"),
      trace: stubTrace()
    });

    assert.equal(expenseParserCalled, false, rawText);
    assert.equal(createDraftCalled, false, rawText);
    const expectedText = /[а-яё]/iu.test(rawText) ? "не обычный расход" : "does not look like a regular expense";
    assert.ok(sent.some((message) => String(message.text).includes(expectedText)), rawText);
  }
});

test("processQueuedMessage keeps airport transfer as a regular expense candidate", async () => {
  let expenseParserCalled = false;
  let draft = null;
  const sent = [];
  await processQueuedMessage({
    message: { chat: { id: 5 } },
    from: { id: 100 },
    user: { id: 1, interface_language: "en", base_currency: "THB", onboarding_step: "completed", timezone: "Asia/Bangkok" },
    rawText: "airport transfer 500 baht",
    inputType: "text",
    repository: {
      async recordAppEvent() {},
      async createDraft(userId, sourceText, expenses) {
        draft = { userId, sourceText, expenses };
        return { id: 42 };
      },
      async setDraftMessageRef() {}
    },
    token: null,
    miniAppUrl: "http://x",
    expenseParser: {
      async parse() {
        expenseParserCalled = true;
        return {
          expenses: [{
            amount: 500,
            currency: "THB",
            description: "airport transfer",
            category_slug: "transport",
            tags: [],
            spent_at: "2026-06-30T10:00:00.000Z",
            budget_impact: "regular",
            confidence: 0.8,
            needs_review: false
          }]
        };
      }
    },
    telegramClient: {
      async sendMessage(message) {
        sent.push(message);
        return { ok: true, result: { message_id: 777 } };
      },
      async editMessageText(message) {
        sent.push(message);
        return { ok: true, result: { message_id: 777 } };
      }
    },
    now: () => new Date("2026-06-30T10:00:00Z"),
    trace: stubTrace()
  });

  assert.equal(expenseParserCalled, true);
  assert.equal(draft.sourceText, "airport transfer 500 baht");
  assert.equal(draft.expenses[0].category_slug, "transport");
  assert.equal(sent.some((message) => String(message.text).includes("does not look like a regular expense")), false);
});

test("processQueuedMessage uses base-currency preview for large budget top-up warning", async () => {
  const repository = {
    async createBudgetTopupDraft(userId, sourceText, item) {
      return { id: 42, status: "pending", item };
    },
    async previewBudgetTopup(userId, item) {
      assert.equal(userId, 1);
      assert.equal(item.currency, "USD");
      return { amountBase: 9780, baseBudget: 2000, large: true, monthKey: "2026-06" };
    },
    async recordAppEvent() {}
  };
  const sent = [];
  const telegramClient = {
    async sendMessage(message) {
      sent.push(message);
      return { ok: true, result: { message_id: 777 } };
    },
    async editMessageText(message) {
      sent.push(message);
      return { ok: true, result: { message_id: 777 } };
    }
  };

  await processQueuedMessage({
    message: { chat: { id: 5 } },
    from: { id: 100 },
    user: { id: 1, interface_language: "en", base_currency: "THB", onboarding_step: "completed", timezone: "Asia/Bangkok", monthly_budget_amount: "48000" },
    rawText: "add $300 to my budget",
    inputType: null,
    repository,
    token: null,
    miniAppUrl: "http://x",
    expenseParser: { async parse() { throw new Error("expense parser should not be called"); } },
    telegramClient,
    now: () => new Date("2026-06-30T10:00:00Z"),
    trace: stubTrace()
  });

  assert.ok(sent.some((message) => String(message.text).includes("Very large top-up")));
});

test("/feedback prompts for one feedback message without creating an expense draft", async () => {
  const repo = {
    ...fakeRepository(),
    user: { id: 7, telegram_user_id: 100, interface_language: "en", onboarding_step: "completed", base_currency: "THB" },
    createDraftCalled: false,
    async createDraft() {
      this.createDraftCalled = true;
      return { id: 42 };
    }
  };
  let expenseParserCalled = false;
  const messages = [];
  const bot = createTelegramBot({
    token: null,
    miniAppUrl: "http://x",
    repository: repo,
    expenseParser: {
      async parse() {
        expenseParserCalled = true;
        return { expenses: [] };
      }
    },
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate(textUpdate("/feedback", 100));

  assert.equal(expenseParserCalled, false);
  assert.equal(repo.createDraftCalled, false);
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /one message/i);
  assert.match(messages[0].text, /developer/i);
});

test("/feedback with inline text saves immediately without creating an expense draft", async () => {
  const savedFeedback = [];
  let expenseParserCalled = false;
  const repo = {
    ...fakeRepository(),
    user: { id: 7, telegram_user_id: 100, interface_language: "en", onboarding_step: "completed", base_currency: "THB" },
    createDraftCalled: false,
    async createFeedback(input) {
      savedFeedback.push(input);
      return { id: 57, ...input, status: "new", source: input.source ?? "bot" };
    },
    async createDraft() {
      this.createDraftCalled = true;
      return { id: 42 };
    }
  };
  const messages = [];
  const bot = createTelegramBot({
    token: null,
    miniAppUrl: "http://x",
    repository: repo,
    expenseParser: {
      async parse() {
        expenseParserCalled = true;
        return { expenses: [] };
      }
    },
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate(textUpdate("/feedback test text", 100));

  assert.deepEqual(savedFeedback, [{
    userId: 7,
    telegramUserId: 100,
    message: "test text",
    source: "bot",
    status: "new"
  }]);
  assert.equal(expenseParserCalled, false);
  assert.equal(repo.createDraftCalled, false);
  assert.ok(messages.some((message) => /received your feedback/i.test(message.text)));
});

test("/feedback saves next text, notifies admins, bypasses parser, then resumes normal expenses", async () => {
  const savedFeedback = [];
  const draftSources = [];
  let expenseParserCalls = 0;
  const repo = {
    ...fakeRepository(),
    user: { id: 7, telegram_user_id: 100, interface_language: "en", onboarding_step: "completed", base_currency: "THB", timezone: "Asia/Bangkok" },
    async createFeedback(input) {
      savedFeedback.push(input);
      return { id: 55, ...input, status: "new", source: input.source ?? "bot" };
    },
    async createDraft(userId, sourceText, items) {
      draftSources.push({ userId, sourceText, items });
      return { id: 42 };
    }
  };
  const messages = [];
  const bot = createTelegramBot({
    token: null,
    miniAppUrl: "http://x",
    repository: repo,
    adminTelegramIds: new Set([9001]),
    expenseParser: {
      async parse(text) {
        expenseParserCalls += 1;
        return {
          expenses: [{
            amount: 70,
            currency: "THB",
            description: text,
            category_slug: "food_cafe",
            tags: [],
            spent_at: "2026-06-30T10:00:00.000Z",
            budget_impact: "regular",
            confidence: 0.8,
            needs_review: false
          }]
        };
      }
    },
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate(textUpdate("/feedback", 100));
  await bot.handleUpdate(textUpdate("Category editing is confusing", 100));
  await bot.handleUpdate(textUpdate("coffee 70", 100));

  assert.equal(savedFeedback.length, 1);
  assert.deepEqual(savedFeedback[0], {
    userId: 7,
    telegramUserId: 100,
    message: "Category editing is confusing",
    source: "bot",
    status: "new"
  });
  assert.equal(expenseParserCalls, 1);
  assert.equal(draftSources.length, 1);
  assert.equal(draftSources[0].sourceText, "coffee 70");
  assert.ok(messages.some((message) => message.chatId === 10 && /received your feedback/i.test(message.text)));
  const adminMessage = messages.find((message) => message.chatId === 9001);
  assert.ok(adminMessage);
  assert.match(adminMessage.text, /New feedback/);
  assert.match(adminMessage.text, /userId: 7/);
  assert.match(adminMessage.text, /telegramUserId: 100/);
  assert.match(adminMessage.text, /Category editing is confusing/);
});

test("/feedback saves next text while user is in onboarding", async () => {
  const savedFeedback = [];
  let onboardingDataUpdated = false;
  let expenseParserCalls = 0;
  const repo = {
    ...fakeRepository(),
    user: { id: 7, telegram_user_id: 100, interface_language: "en", onboarding_step: "budget_setup", base_currency: "THB" },
    async updateOnboardingData() {
      onboardingDataUpdated = true;
      throw new Error("feedback text must not enter onboarding");
    },
    async createFeedback(input) {
      savedFeedback.push(input);
      return { id: 56, ...input, status: "new", source: input.source ?? "bot" };
    }
  };
  const messages = [];
  const bot = createTelegramBot({
    token: null,
    miniAppUrl: "http://x",
    repository: repo,
    expenseParser: {
      async parse() {
        expenseParserCalls += 1;
        return { expenses: [] };
      }
    },
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate(textUpdate("/feedback", 100));
  await bot.handleUpdate(textUpdate("Onboarding budget copy is unclear", 100));

  assert.equal(savedFeedback.length, 1);
  assert.deepEqual(savedFeedback[0], {
    userId: 7,
    telegramUserId: 100,
    message: "Onboarding budget copy is unclear",
    source: "bot",
    status: "new"
  });
  assert.equal(onboardingDataUpdated, false);
  assert.equal(expenseParserCalls, 0);
  assert.ok(messages.some((message) => /received your feedback/i.test(message.text)));
});

test("/feedback keeps pending state for too-short text", async () => {
  const savedFeedback = [];
  let expenseParserCalls = 0;
  const repo = {
    ...fakeRepository(),
    user: { id: 7, telegram_user_id: 100, interface_language: "en", onboarding_step: "completed", base_currency: "THB" },
    async createFeedback(input) {
      savedFeedback.push(input);
      return { id: 55, ...input };
    }
  };
  const messages = [];
  const bot = createTelegramBot({
    token: null,
    miniAppUrl: "http://x",
    repository: repo,
    expenseParser: {
      async parse() {
        expenseParserCalls += 1;
        return { expenses: [] };
      }
    },
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate(textUpdate("/feedback", 100));
  await bot.handleUpdate(textUpdate("ok", 100));
  await bot.handleUpdate(textUpdate("Please add a clearer category edit button", 100));

  assert.equal(savedFeedback.length, 1);
  assert.equal(savedFeedback[0].message, "Please add a clearer category edit button");
  assert.equal(expenseParserCalls, 0);
  assert.ok(messages.some((message) => /a little more detail/i.test(message.text)));
});

test("/feedback inline too-short text keeps pending state for the next message", async () => {
  const savedFeedback = [];
  let expenseParserCalls = 0;
  const draftSources = [];
  const repo = {
    ...fakeRepository(),
    user: { id: 7, telegram_user_id: 100, interface_language: "en", onboarding_step: "completed", base_currency: "THB" },
    async createFeedback(input) {
      savedFeedback.push(input);
      return { id: 55, ...input };
    },
    async createDraft(userId, sourceText, items) {
      draftSources.push({ userId, sourceText, items });
      return { id: 42 };
    }
  };
  const messages = [];
  const bot = createTelegramBot({
    token: null,
    miniAppUrl: "http://x",
    repository: repo,
    expenseParser: {
      async parse() {
        expenseParserCalls += 1;
        return { expenses: [] };
      }
    },
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate(textUpdate("/feedback ok", 100));
  await bot.handleUpdate(textUpdate("Please make category editing clearer", 100));

  assert.equal(savedFeedback.length, 1);
  assert.equal(savedFeedback[0].message, "Please make category editing clearer");
  assert.equal(expenseParserCalls, 0);
  assert.equal(draftSources.length, 0);
  assert.ok(messages.some((message) => /a little more detail/i.test(message.text)));
  assert.ok(messages.some((message) => /received your feedback/i.test(message.text)));
});

test("/feedback still saves when admin notification fails", async () => {
  const savedFeedback = [];
  const repo = {
    ...fakeRepository(),
    user: { id: 7, telegram_user_id: 100, interface_language: "en", onboarding_step: "completed", base_currency: "THB" },
    async createFeedback(input) {
      savedFeedback.push(input);
      return { id: 55, ...input };
    }
  };
  const messages = [];
  const bot = createTelegramBot({
    token: null,
    miniAppUrl: "http://x",
    repository: repo,
    adminTelegramIds: new Set([9001]),
    telegramClient: {
      async sendMessage(message) {
        if (message.chatId === 9001) throw new Error("telegram down");
        messages.push(message);
        return { ok: true, result: { message_id: 777 } };
      },
      async editMessageText(message) {
        messages.push(message);
        return { ok: true, result: { message_id: 777 } };
      }
    }
  });

  await bot.handleUpdate(textUpdate("/feedback", 100));
  await assert.doesNotReject(() => bot.handleUpdate(textUpdate("The dashboard is hard to scan", 100)));

  assert.equal(savedFeedback.length, 1);
  assert.ok(messages.some((message) => /received your feedback/i.test(message.text)));
});

test("budget top-up confirm explains previous-month top-ups are not supported", async () => {
  const { handleCallback } = await import("../src/telegram.js");
  const calls = [];
  const repository = {
    async getUserByTelegramId() {
      return { id: 1, telegram_user_id: "100", interface_language: "en", onboarding_step: "completed" };
    },
    async confirmBudgetTopupDraft() {
      return { outcome: "wrong_month", targetMonthKey: "2026-06" };
    }
  };
  const telegramClient = {
    async answerCallbackQuery(args) {
      calls.push(args);
      return { ok: true };
    }
  };

  await handleCallback({
    update: {
      callback_query: {
        id: "cb-1",
        data: "bt:42:confirm",
        from: { id: 100 },
        message: { chat: { id: 5 }, message_id: 10 }
      }
    },
    repository,
    token: null,
    miniAppUrl: "http://x",
    telegramClient,
    trace: stubTrace(),
    now: () => new Date("2026-07-01T01:00:00+07:00")
  });

  assert.ok(calls.some((call) => String(call.text).includes("current month")));
});

test("budget top-up confirm keeps undo and Mini App actions on success", async () => {
  const { handleCallback } = await import("../src/telegram.js");
  const calls = [];
  const repository = {
    async getUserByTelegramId() {
      return { id: 1, telegram_user_id: "100", interface_language: "en", onboarding_step: "completed" };
    },
    async confirmBudgetTopupDraft() {
      return {
        outcome: "confirmed",
        alreadySaved: false,
        topup: {
          id: 99,
          kind: "income",
          amount_original: 200,
          currency_original: "USD",
          amount_base: 7300,
          base_currency: "THB"
        },
        dashboardSnapshot: {
          baseCurrency: "THB",
          monthlyBudget: 55300,
          freeRemaining: 14000
        }
      };
    },
    async recordAppEvent() {}
  };

  await handleCallback({
    update: {
      callback_query: {
        id: "cb-confirm-topup",
        data: "bt:42:confirm",
        from: { id: 100 },
        message: { chat: { id: 5 }, message_id: 10 }
      }
    },
    repository,
    token: null,
    miniAppUrl: "http://x",
    telegramClient: capturingClient(calls),
    trace: stubTrace(),
    now: () => new Date("2026-06-30T10:00:00Z")
  });

  const edit = calls.find((call) => call.method === "editMessageText");
  assert.ok(edit);
  assert.match(edit.text, /Budget updated/);
  assert.equal(edit.replyMarkup.inline_keyboard[0][0].callback_data, "bt:99:undo");
  assert.equal(edit.replyMarkup.inline_keyboard[1][0].web_app.url, "http://x?telegramUserId=100");
});

test("budget top-up cancel and undo leave a Mini App action", async () => {
  const { handleCallback } = await import("../src/telegram.js");
  for (const action of ["cancel", "undo"]) {
    const calls = [];
    const repository = {
      async getUserByTelegramId() {
        return { id: 1, telegram_user_id: "100", interface_language: "en", onboarding_step: "completed" };
      },
      async cancelBudgetTopupDraft() {
        return { cancelled: true };
      },
      async undoBudgetTopup() {
        return {
          undone: true,
          topup: { amount_original: 200, currency_original: "USD" },
          dashboardSnapshot: { baseCurrency: "THB", monthlyBudget: 48000, freeRemaining: 9000 }
        };
      },
      async recordAppEvent() {}
    };

    await handleCallback({
      update: {
        callback_query: {
          id: `cb-topup-${action}`,
          data: action === "cancel" ? "bt:42:cancel" : "bt:99:undo",
          from: { id: 100 },
          message: { chat: { id: 5 }, message_id: 10 }
        }
      },
      repository,
      token: null,
      miniAppUrl: "http://x",
      telegramClient: capturingClient(calls),
      trace: stubTrace(),
      now: () => new Date("2026-06-30T10:00:00Z")
    });

    const edit = calls.find((call) => call.method === "editMessageText");
    assert.ok(edit, action);
    assert.equal(edit.replyMarkup.inline_keyboard[0][0].web_app.url, "http://x?telegramUserId=100", action);
  }
});

test("updateDraftMessageToSaved edits the stored message and falls back to a new one on failure", async () => {
  const { updateDraftMessageToSaved } = await import("../src/telegram.js");
  const calls = [];
  const telegramClient = {
    editMessageText: async () => { throw { status: 400, body: "Bad Request: message to edit not found" }; },
    sendMessage: async (args) => { calls.push(["sendMessage", args]); return { ok: true }; },
    editMessageReplyMarkup: async (args) => { calls.push(["editMessageReplyMarkup", args]); return { ok: true }; }
  };
  await updateDraftMessageToSaved({
    token: null, draft: { id: 7, tg_chat_id: 5, tg_message_id: 9 }, text: "saved", replyMarkup: { inline_keyboard: [] }, telegramClient
  });
  assert.ok(calls.some(([name]) => name === "sendMessage"), "expected fallback new message");
});

test("updateDraftMessageToSaved is a no-op without a stored reference", async () => {
  const { updateDraftMessageToSaved } = await import("../src/telegram.js");
  const telegramClient = { editMessageText: async () => { throw new Error("should not be called"); } };
  await updateDraftMessageToSaved({ token: null, draft: { id: 7, tg_chat_id: null, tg_message_id: null }, text: "x", replyMarkup: null, telegramClient });
});

test("updateTelegramMessageAfterExpenseDelete shows the deleted-state when no expenses remain", async () => {
  const { updateTelegramMessageAfterExpenseDelete } = await import("../src/telegram.js");
  const calls = [];
  const telegramClient = {
    editMessageText: async (message) => { calls.push({ method: "editMessageText", ...message }); return { ok: true }; },
    sendMessage: async () => { throw new Error("sendMessage should not be called"); },
    editMessageReplyMarkup: async () => { throw new Error("editMessageReplyMarkup should not be called"); }
  };
  await updateTelegramMessageAfterExpenseDelete({
    token: "test-token",
    draft: { id: 7, tg_chat_id: 5, tg_message_id: 9 },
    remainingExpenses: [],
    dashboardSnapshot: {},
    language: "en",
    miniAppUrl: "http://x",
    telegramUserId: 100,
    telegramClient
  });
  const edit = calls.find((call) => call.method === "editMessageText");
  assert.ok(edit, "expected editMessageText");
  assert.equal(edit.text, "🗑 Entry deleted.\nThis expense was deleted in Mini App and no longer counts.");
  assert.ok(edit.replyMarkup?.inline_keyboard?.[0]?.[0]?.web_app?.url?.includes("http://x?telegramUserId=100"), "expected the Mini App web_app url");
});

test("updateTelegramMessageAfterExpenseDelete re-renders the saved summary when expenses remain", async () => {
  const { updateTelegramMessageAfterExpenseDelete } = await import("../src/telegram.js");
  const calls = [];
  const telegramClient = {
    editMessageText: async (message) => { calls.push({ method: "editMessageText", ...message }); return { ok: true }; },
    sendMessage: async () => { throw new Error("sendMessage should not be called"); },
    editMessageReplyMarkup: async () => { throw new Error("editMessageReplyMarkup should not be called"); }
  };
  const remaining = [{ amount_base: 120, amount_original: 120, currency_original: "THB", description: "latte", category_slug: "food_cafe" }];
  await updateTelegramMessageAfterExpenseDelete({
    token: "test-token",
    draft: { id: 7, tg_chat_id: 5, tg_message_id: 9 },
    remainingExpenses: remaining,
    dashboardSnapshot: { baseCurrency: "THB", today: 0, monthlyBudget: 45000 },
    language: "en",
    miniAppUrl: "http://x",
    telegramUserId: 100,
    telegramClient
  });
  const edit = calls.find((call) => call.method === "editMessageText");
  assert.ok(edit, "expected editMessageText");
  assert.match(edit.text, /latte/);
});

test("updateTelegramMessageAfterExpenseDelete is a no-op without a stored reference", async () => {
  const { updateTelegramMessageAfterExpenseDelete } = await import("../src/telegram.js");
  const calls = [];
  const telegramClient = {
    editMessageText: async (message) => { calls.push({ method: "editMessageText", ...message }); return { ok: true }; }
  };
  await updateTelegramMessageAfterExpenseDelete({
    token: "test-token",
    draft: { id: 7, tg_chat_id: null, tg_message_id: null },
    remainingExpenses: [],
    dashboardSnapshot: {},
    language: "en",
    miniAppUrl: "http://x",
    telegramUserId: 100,
    telegramClient
  });
  assert.equal(calls.length, 0, "editMessageText should not be called without a stored reference");
});

test("updateDraftMessageToDraftState edits the stored draft preview with the current items", async () => {
  const { updateDraftMessageToDraftState } = await import("../src/telegram.js");
  const calls = [];
  const telegramClient = {
    editMessageText: async (args) => { calls.push(["editMessageText", args]); return { ok: true }; },
    sendMessage: async () => { throw new Error("sendMessage should not be called"); },
    editMessageReplyMarkup: async () => { throw new Error("editMessageReplyMarkup should not be called"); }
  };
  const items = [{ amount: 1, currency: "THB", amount_base: 1, category_slug: "food_cafe", description: "coffee", spent_at: "2026-06-26T10:00:00Z", budget_impact: "regular", tags: [] }];
  await updateDraftMessageToDraftState({
    token: null, draft: { id: 7, tg_chat_id: 5, tg_message_id: 9 }, items, miniAppUrl: "http://x", telegramUserId: 100, language: "ru", baseCurrency: "THB", telegramClient
  });
  const edit = calls.find(([name]) => name === "editMessageText");
  assert.ok(edit, "expected editMessageText");
  assert.equal(edit[1].chatId, 5);
  assert.equal(edit[1].messageId, 9);
  assert.match(edit[1].text, /Еда и кафе/);
  assert.ok(Array.isArray(edit[1].replyMarkup?.inline_keyboard), "expected a draft keyboard");
});

test("Mini App draft synchronization prepares the latest total after amount, currency, and date changes", async () => {
  const { updateDraftMessageToDraftState } = await import("../src/telegram.js");
  const calls = [];
  const previewCalls = [];
  const user = { id: 1, base_currency: "USD", interface_language: "en" };
  const repository = {
    async prepareDraftPreview(items, passedUser) {
      previewCalls.push({ items, user: passedUser });
      const dateBonus = items[1].spent_at.startsWith("2026-07-19") ? 3 : 0;
      const currencyBonus = items[1].currency === "RUB" ? 2 : 0;
      return {
        kind: "converted",
        baseCurrency: "USD",
        total: items[0].amount + items[1].amount + dateBonus + currencyBonus
      };
    }
  };
  const telegramClient = {
    editMessageText: async (args) => { calls.push(args); return { ok: true }; },
    sendMessage: async () => { throw new Error("sendMessage should not be called"); },
    editMessageReplyMarkup: async () => { throw new Error("editMessageReplyMarkup should not be called"); }
  };
  const original = [
    { amount: 10, currency: "USD", category_slug: "food_cafe", description: "coffee", spent_at: "2026-07-20T08:00:00.000Z" },
    { amount: 20, currency: "EUR", category_slug: "food_cafe", description: "lunch", spent_at: "2026-07-20T12:00:00.000Z" }
  ];
  const revisions = [
    [{ ...original[0], amount: 15 }, original[1]],
    [{ ...original[0], amount: 15 }, { ...original[1], currency: "RUB" }],
    [{ ...original[0], amount: 15 }, { ...original[1], currency: "RUB", spent_at: "2026-07-19T12:00:00.000Z" }]
  ];

  for (const items of revisions) {
    await updateDraftMessageToDraftState({
      token: null,
      draft: { id: 7, tg_chat_id: 5, tg_message_id: 9 },
      items,
      miniAppUrl: "http://x",
      telegramUserId: 100,
      language: "en",
      repository,
      user,
      telegramClient
    });
  }

  assert.deepEqual(previewCalls, revisions.map((items) => ({ items, user })));
  assert.match(calls[0].text, /<b>Total:<\/b> 35\.00 USD/);
  assert.match(calls[1].text, /<b>Total:<\/b> 37\.00 USD/);
  assert.match(calls[2].text, /<b>Total:<\/b> 40\.00 USD/);
});

test("Mini App mixed-draft synchronization safely renders unavailable subtotals", async () => {
  const { updateDraftMessageToDraftState } = await import("../src/telegram.js");
  const calls = [];
  const repository = {
    async prepareDraftPreview() {
      return { kind: "unavailable", baseCurrency: "USD" };
    }
  };
  const items = [
    { amount: 10, currency: "USD", category_slug: "food_cafe", description: "coffee", spent_at: "2026-07-20T08:00:00.000Z" },
    { amount: 20, currency: "EUR", category_slug: "food_cafe", description: "lunch", spent_at: "2026-07-20T12:00:00.000Z" }
  ];
  const telegramClient = {
    editMessageText: async (args) => { calls.push(args); return { ok: true }; },
    sendMessage: async () => { throw new Error("sendMessage should not be called"); },
    editMessageReplyMarkup: async () => { throw new Error("editMessageReplyMarkup should not be called"); }
  };

  await updateDraftMessageToDraftState({
    token: null,
    draft: { id: 7, tg_chat_id: 5, tg_message_id: 9 },
    items,
    miniAppUrl: "http://x",
    telegramUserId: 100,
    language: "en",
    repository,
    user: { base_currency: "USD" },
    telegramClient
  });

  assert.match(calls[0].text, /10\.00 USD \+ 20\.00 EUR/);
  assert.match(calls[0].text, /A reliable total in USD is unavailable/);
  assert.doesNotMatch(calls[0].text, /<b>Total:<\/b> 30\.00 USD/);
});

test("Mini App PATCH wiring passes the fetched repository and user to draft synchronization", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const callStart = source.indexOf("await updateDraftMessageToDraftState({");

  assert.notEqual(callStart, -1);
  const invocation = source.slice(callStart, source.indexOf("});", callStart) + 3);
  assert.match(invocation, /\brepository,\s*\n\s*user,/);
});

test("updateDraftMessageToDraftState is a no-op without a stored reference", async () => {
  const { updateDraftMessageToDraftState } = await import("../src/telegram.js");
  const telegramClient = { editMessageText: async () => { throw new Error("should not be called"); } };
  await updateDraftMessageToDraftState({
    token: null, draft: { id: 7, tg_chat_id: null, tg_message_id: null }, items: [], miniAppUrl: "http://x", telegramUserId: 100, language: "ru", baseCurrency: "THB", telegramClient
  });
});

test("updateDraftMessageToDraftState sends a fallback message and clears the old keyboard on edit failure", async () => {
  const { updateDraftMessageToDraftState } = await import("../src/telegram.js");
  const calls = [];
  const telegramClient = {
    editMessageText: async (args) => { calls.push(["editMessageText", args]); throw { status: 400, body: "Bad Request: message to edit not found" }; },
    sendMessage: async (args) => { calls.push(["sendMessage", args]); return { ok: true }; },
    editMessageReplyMarkup: async (args) => { calls.push(["editMessageReplyMarkup", args]); return { ok: true }; }
  };
  const items = [{ amount: 1, currency: "THB", amount_base: 1, category_slug: "food_cafe", description: "coffee", spent_at: "2026-06-26T10:00:00Z", budget_impact: "regular", tags: [] }];
  await updateDraftMessageToDraftState({
    token: null, draft: { id: 7, tg_chat_id: 5, tg_message_id: 9 }, items, miniAppUrl: "http://x", telegramUserId: 100, language: "ru", baseCurrency: "THB", telegramClient
  });
  assert.ok(calls.some(([name]) => name === "sendMessage"), "expected fallback new message");
  const markup = calls.find(([name]) => name === "editMessageReplyMarkup");
  assert.ok(markup, "expected old keyboard to be cleared");
  assert.deepEqual(markup[1].replyMarkup, { inline_keyboard: [] });
});

test("draftCanceledMessageText and savedSummaryKeyboard are localized", async () => {
  const { draftCanceledMessageText, savedSummaryKeyboard } = await import("../src/telegram.js");
  assert.equal(draftCanceledMessageText("en"), "🗑 Draft cancelled, expense not saved");
  assert.equal(draftCanceledMessageText("ru"), "🗑 Черновик отменён, расход не сохранён");
  const kb = savedSummaryKeyboard("http://x", 100, "en");
  assert.ok(kb.inline_keyboard[0][0].web_app?.url?.includes("telegramUserId=100"));
});

function stubTrace() {
  return { start() {}, end() {}, event() {}, failActive() {}, getDurations() { return {}; }, getMetadata() { return {}; } };
}

test("legacy confirm:42 callback still confirms via the shared handler", async () => {
  let confirmedWith;
  const repository = {
    ...fakeRepository(),
    async getUserByTelegramId() {
      return { id: 1, interface_language: "en", base_currency: "THB", onboarding_step: "completed" };
    },
    async saveDraftAsExpense(id) {
      confirmedWith = id;
      return { expenses: [{ amount_base: 80, category_slug: "food_cafe", description: "coffee" }], dashboardSnapshot: (await this.dashboard()).snapshot, alreadySaved: false };
    }
  };
  const messages = [];
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository,
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate({
    callback_query: {
      id: "cq1",
      data: "confirm:42",
      from: { id: 100 },
      message: { chat: { id: 1 }, message_id: 9 }
    }
  });

  assert.equal(confirmedWith, "42");
});

test("draft type callback (d: scheme) large_oneoff value updates budget impact", async () => {
  const calls = [];
  const repo = fakeRepository();
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: {
      async sendMessage(message) { calls.push({ method: "sendMessage", ...message }); return { ok: true }; },
      async editMessageText(message) { calls.push({ method: "editMessageText", ...message }); return { ok: true }; },
      async answerCallbackQuery(message) { calls.push({ method: "answerCallbackQuery", ...message }); return { ok: true }; },
      async deleteMessage() { return { ok: true }; }
    }
  });

  await bot.handleUpdate({
    callback_query: {
      id: "callback-d-type-large",
      data: "d:42:t:l",
      from: { id: 100 },
      message: { chat: { id: 10 }, message_id: 72 }
    }
  });

  assert.equal(repo.updatedItems[0].budget_impact, "large_oneoff");
  const edit = calls.find((call) => call.method === "editMessageText");
  assert.ok(edit);
  assert.equal(edit.messageId, 72);
});

test("cancel callback answers a different toast for each non-canceled outcome reason", async () => {
  const cases = [
    { reason: "already_cancelled", expected: "Этот черновик уже отменён." },
    { reason: "already_confirmed", expected: "Уже сохранено" },
    { reason: "not_found", expected: "⚠️ Что-то пошло не так. Попробуйте ещё раз." }
  ];

  for (const { reason, expected } of cases) {
    const calls = [];
    const repo = fakeRepository();
    repo.cancelDraft = async () => ({ canceled: false, reason });
    const bot = createTelegramBot({
      token: "test-token",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      telegramClient: capturingClient(calls)
    });

    await bot.handleUpdate({
      callback_query: {
        id: `callback-cancel-${reason}`,
        data: "cancel:42",
        from: { id: 100 },
        message: { chat: { id: 10 }, message_id: 55 }
      }
    });

    const answer = calls.find((call) => call.method === "answerCallbackQuery");
    assert.ok(answer, reason);
    assert.equal(answer.text, expected, reason);
    assert.equal(calls.some((call) => call.method === "editMessageText"), false, reason);
    assert.equal(calls.some((call) => call.method === "sendMessage"), false, reason);
  }
});

test("cancel callback with a real cancel edits the draft into the canceled message with an empty keyboard", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.cancelDraft = async () => ({ canceled: true });
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: capturingClient(calls)
  });

  await bot.handleUpdate({
    callback_query: {
      id: "callback-cancel-real",
      data: "cancel:42",
      from: { id: 100 },
      message: { chat: { id: 10 }, message_id: 55, reply_to_message: { message_id: 21 } }
    }
  });

  const edit = calls.find((call) => call.method === "editMessageText");
  assert.ok(edit);
  assert.equal(edit.messageId, 55);
  assert.equal(edit.text, "🗑 Черновик отменён, расход не сохранён");
  assert.deepEqual(edit.replyMarkup, { inline_keyboard: [] });
  assert.equal(calls.some((call) => call.method === "sendMessage"), false);
  assert.deepEqual(repo.events, [
    { userId: 1, eventName: "expense_draft_cancelled", metadata: { draftType: "regular" } }
  ]);
});

test("cancel callback fallback sends a native reply to the source message", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.cancelDraft = async () => ({ canceled: true });
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: {
      ...capturingClient(calls),
      async editMessageText(message) {
        calls.push({ method: "editMessageText", ...message });
        throw new Error("edit failed");
      }
    }
  });

  await bot.handleUpdate({
    callback_query: {
      id: "callback-cancel-reply-fallback",
      data: "cancel:42",
      from: { id: 100 },
      message: { chat: { id: 10 }, message_id: 55, reply_to_message: { message_id: 21 } }
    }
  });

  const sent = calls.find((call) => call.method === "sendMessage");
  assert.ok(sent);
  assert.equal(sent.text, "🗑 Черновик отменён, расход не сохранён");
  assert.deepEqual(sent.replyParameters, { message_id: 21, allow_sending_without_reply: true });
});

test("cancel callback retries without reply when Telegram rejects the source reply", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.cancelDraft = async () => ({ canceled: true });
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: repo,
    telegramClient: {
      ...capturingClient(calls),
      async editMessageText(message) {
        calls.push({ method: "editMessageText", ...message });
        throw new Error("edit failed");
      },
      async sendMessage(message) {
        calls.push({ method: "sendMessage", ...message });
        if (message.replyParameters) {
          throw Object.assign(new Error("reply unavailable"), { status: 400 });
        }
        return { ok: true };
      }
    }
  });

  await assert.doesNotReject(bot.handleUpdate({
    callback_query: {
      id: "callback-cancel-no-reply-fallback",
      data: "cancel:42",
      from: { id: 100 },
      message: { chat: { id: 10 }, message_id: 55, reply_to_message: { message_id: 21 } }
    }
  }));

  const sends = calls.filter((call) => call.method === "sendMessage");
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0].replyParameters, { message_id: 21, allow_sending_without_reply: true });
  assert.equal(sends[1].replyParameters, undefined);
  assert.equal(sends[1].text, "🗑 Черновик отменён, расход не сохранён");
});

test("draft cancellation message is localized as one line without a trailing period", async () => {
  const { draftCanceledMessageText } = await import("../src/telegram.js");
  assert.equal(draftCanceledMessageText("ru"), "🗑 Черновик отменён, расход не сохранён");
  assert.equal(draftCanceledMessageText("en"), "🗑 Draft cancelled, expense not saved");
});

test("confirm callback clears the old draft keyboard and sends a new message when editing fails", async () => {
  const calls = [];
  const repo = fakeRepository();
  const originalError = console.error;
  console.error = () => {};
  try {
    const bot = createTelegramBot({
      token: "test-token",
      miniAppUrl: "http://localhost:3000",
      repository: repo,
      telegramClient: {
        async sendMessage(message) { calls.push({ method: "sendMessage", ...message }); return { ok: true }; },
        async editMessageText(message) { calls.push({ method: "editMessageText", ...message }); throw new Error("edit failed"); },
        async answerCallbackQuery(message) { calls.push({ method: "answerCallbackQuery", ...message }); return { ok: true }; },
        async editMessageReplyMarkup(message) { calls.push({ method: "editMessageReplyMarkup", ...message }); return { ok: true }; },
        async deleteMessage() { return { ok: true }; }
      }
    });

    await bot.handleUpdate({
      callback_query: {
        id: "callback-confirm-fallback",
        data: "confirm:42",
        from: { id: 100 },
        message: { chat: { id: 10 }, message_id: 55 }
      }
    });
  } finally {
    console.error = originalError;
  }

  const markup = calls.find((call) => call.method === "editMessageReplyMarkup");
  assert.ok(markup);
  assert.equal(markup.messageId, 55);
  assert.deepEqual(markup.replyMarkup, { inline_keyboard: [] });
  assert.ok(calls.some((call) => call.method === "sendMessage"));
});

function capturingClient(calls) {
  return {
    async sendMessage(message) { calls.push({ method: "sendMessage", ...message }); return { ok: true }; },
    async sendDocument(message) { calls.push({ method: "sendDocument", ...message }); return { ok: true }; },
    async editMessageText(message) { calls.push({ method: "editMessageText", ...message }); return { ok: true }; },
    async answerCallbackQuery(message) { calls.push({ method: "answerCallbackQuery", ...message }); return { ok: true }; },
    async editMessageReplyMarkup(message) { calls.push({ method: "editMessageReplyMarkup", ...message }); return { ok: true }; },
    async deleteMessage(message) { calls.push({ method: "deleteMessage", ...message }); return { ok: true }; }
  };
}
