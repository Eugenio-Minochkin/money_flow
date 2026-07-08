import test from "node:test";
import assert from "node:assert/strict";

import { parseAdminTelegramIds } from "../src/adminAccess.js";
import { createExpenseParser } from "../src/expenseParser.js";
import { createTelegramBot, processQueuedMessage, sendTelegramMessage, sendWeeklyReports } from "../src/telegram.js";

test("exports the Telegram message sender used by the production server", async () => {
  const calls = [];
  const telegramClient = {
    async sendMessage(message) {
      calls.push(message);
      return { ok: true, result: { message_id: 42 } };
    }
  };
  const replyMarkup = { inline_keyboard: [[{ text: "Open", url: "https://example.com" }]] };

  const result = await sendTelegramMessage({
    token: "unused-with-client",
    chatId: 100,
    text: "Release digest",
    replyMarkup,
    telegramClient
  });

  assert.deepEqual(calls, [{ chatId: 100, text: "Release digest", replyMarkup }]);
  assert.deepEqual(result, { ok: true, result: { message_id: 42 } });
});

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

    assert.match(calls[0][1].text, /Заношу расход/);
    assert.match(calls[1][1].text, /Я понял так/);
    assert.match(calls[1][1].text, /кофе/);
    assert.equal(calls[1][1].replyMarkup.inline_keyboard[0][0].callback_data, "d:42:confirm");
  } finally {
    console.log = originalLog;
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
  assert.equal(repo.events[2].eventName, "message_processing_completed");
  assert.equal(repo.events[2].metadata.inputType, "text");
  assert.equal(Number.isFinite(repo.events[2].metadata.processingTotalMs), true);
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
  assert.equal(completed.metadata.result, "draft_created");
  assert.equal(completed.metadata.status, "draft_created");
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
        from: { id: 100, first_name: "M" },
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
  assert.ok(stageLines.every((line) => /userId=100/.test(line)));
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
            localFastPathAccepted: true,
            localFastPathRejectReason: null,
            categoryResolution: "resolved",
            llmSkipped: true,
            fastPathMode: "enabled",
            shadowDisagreement: null,
            shadowDisagreementFields: [],
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
  assert.equal(completed.metadata.localFastPathAccepted, true);
  assert.equal(completed.metadata.llmSkipped, true);
  assert.equal(completed.metadata.fastPathMode, "enabled");
  assert.equal(completed.metadata.categoryResolution, "resolved");
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
            localFastPathAccepted: true,
            localFastPathRejectReason: null,
            categoryResolution: "resolved",
            llmSkipped: true,
            fastPathMode: "enabled",
            shadowDisagreement: null,
            shadowDisagreementFields: [],
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
    assert.deepEqual(repo.events, [
      { userId: 1, eventName: "expense_draft_confirmed", metadata: { draftType: "regular" } },
      { userId: 1, eventName: "expense_saved", metadata: { draftType: "regular" } }
    ]);
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

test("confirm callback edits the original draft message into saved summary and replaces draft keyboard with Mini App", async () => {
  const calls = [];
  const repo = fakeRepository();
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
  assert.deepEqual(edit.replyMarkup, {
    inline_keyboard: [[{
      text: "📱 Открыть Mini App",
      web_app: { url: "http://localhost:3000?telegramUserId=100" }
    }]]
  });
  assert.ok(calls.some((call) => call.method === "answerCallbackQuery"));
  assert.equal(calls.some((call) => call.method === "sendMessage" && /Записал|Saved/.test(call.text)), false);
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

    assert.match(calls[0][1].text, /Заношу расход|Adding expense/);
    assert.match(calls[1][1].text, /кофе/);
    assert.match(calls[1][1].text, /70 THB/);
    assert.equal(calls[1][1].replyMarkup.inline_keyboard[0][0].callback_data, "d:42:confirm");
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
      const period = emptyAdminPeriod({
        activeUsers: repo.events.length > 0 ? 1 : 0,
        messagesTotal: count("message_received"),
        textMessages: repo.events.filter((event) => event.eventName === "message_received" && event.metadata.inputType === "text").length,
        expensesSaved: count("expense_saved"),
        draftsCreated: count("expense_draft_created"),
        draftsConfirmed: count("expense_draft_confirmed"),
        avgTextProcessingSeconds: count("message_processing_completed") > 0 ? 0.1 : null
      });
      return { today: period, last7Days: period, last30Days: period };
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
  assert.match(statsMessage, /Users: 1 active/);
  assert.match(statsMessage, /Messages: 1 total \/ 1 text/);
  assert.match(statsMessage, /Expenses saved: 1/);
  assert.match(statsMessage, /Drafts: 1 created \/ 1 confirmed/);
  assert.match(statsMessage, /Avg processing: text 0\.1s/);
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
          return {
            today: emptyAdminPeriod({ activeUsers: 1 }),
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

  assert.equal(calls.length, 1);
  assert.match(calls[0][1].text, /Admin stats/);
  assert.match(calls[0][1].text, /Today:/);
  assert.match(calls[0][1].text, /Users: 1 active \/ 0 new/);
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
        return {
          today: emptyAdminPeriod(),
          last7Days: emptyAdminPeriod(),
          last30Days: emptyAdminPeriod()
        };
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
  assert.match(messages[0].text, /Admin stats/);
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
    assert.ok(edit.body.reply_markup.inline_keyboard.flat().some((button) => button.text === "🔘 Крупная"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("draft category callback (d: scheme) maps quick code to slug, marks user source and edits in place", async () => {
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
      data: "d:42:c:food",
      from: { id: 100 },
      message: { chat: { id: 10 }, message_id: 71 }
    }
  });

  assert.equal(repo.updatedItems[0].category_slug, "food_cafe");
  assert.equal(repo.updatedItems[0].category_source, "user");
  const edit = calls.find((call) => call.method === "editMessageText");
  assert.ok(edit);
  assert.equal(edit.messageId, 71);
  assert.equal(calls.some((call) => call.method === "sendMessage"), false);
  assert.ok(calls.some((call) => call.method === "answerCallbackQuery"));
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

test("draft confirm callback (d: scheme) shows already-saved toast and skips save events when alreadySaved", async () => {
  const calls = [];
  const repo = fakeRepository();
  repo.saveDraftAsExpense = async () => {
    return { expenses: [{ amount_base: 75 }], dashboardSnapshot: (await repo.dashboard()).snapshot, alreadySaved: true };
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
  assert.equal(answer.text, "Уже сохранено");
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
    assert.ok(keyboard.some((button) => button.callback_data === "d:42:c:food"));
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
    async upsertTelegramUser() {
      return this.user;
    },
    async getUserByTelegramId() {
      return this.user;
    },
    async recordAppEvent(userId, eventName, metadata = {}) {
      this.events.push({ userId, eventName, metadata });
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
    async createDraft() {
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
      return { expenses: [{ amount_base: 75 }], dashboardSnapshot: (await this.dashboard()).snapshot, alreadySaved: false };
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
          needs_review: false,
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
  assert.match(draftCanceledMessageText("en"), /Draft canceled/);
  assert.match(draftCanceledMessageText("ru"), /Черновик отменён/);
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
      message: { chat: { id: 10 }, message_id: 55 }
    }
  });

  const edit = calls.find((call) => call.method === "editMessageText");
  assert.ok(edit);
  assert.equal(edit.messageId, 55);
  assert.equal(edit.text, "🗑 Черновик отменён.\nРасход не был сохранён.");
  assert.deepEqual(edit.replyMarkup, { inline_keyboard: [] });
  assert.equal(calls.some((call) => call.method === "sendMessage"), false);
  assert.deepEqual(repo.events, [
    { userId: 1, eventName: "expense_draft_cancelled", metadata: { draftType: "regular" } }
  ]);
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
    async editMessageText(message) { calls.push({ method: "editMessageText", ...message }); return { ok: true }; },
    async answerCallbackQuery(message) { calls.push({ method: "answerCallbackQuery", ...message }); return { ok: true }; },
    async editMessageReplyMarkup(message) { calls.push({ method: "editMessageReplyMarkup", ...message }); return { ok: true }; },
    async deleteMessage() { return { ok: true }; }
  };
}
