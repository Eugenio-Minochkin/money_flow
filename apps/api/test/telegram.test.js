import test from "node:test";
import assert from "node:assert/strict";

import { parseAdminTelegramIds } from "../src/adminAccess.js";
import { createTelegramBot, sendTelegramMessage, sendWeeklyReports } from "../src/telegram.js";

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
    assert.equal(calls[1][1].replyMarkup.inline_keyboard[0][0].callback_data, "confirm:42");
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
    assert.equal(calls[1][1].replyMarkup.inline_keyboard[0][0].callback_data, "confirm:42");
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
  assert.ok(messages.length > 0);
});

test("photo input is counted and records a parse failure", async () => {
  const repo = fakeRepository();
  const messages = [];
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
  assert.ok(repo.events.some((event) => event.eventName === "expense_parse_failed"));
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

    const keyboard = calls[1][1].replyMarkup.inline_keyboard.flat();
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

test("admin release preview shows user digest and hidden notes", async () => {
  const messages = [];
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: fakeRepository(),
    adminTelegramIds: new Set([100]),
    releaseNotesService: fakeReleaseNotesService({
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
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate({
    message: {
      chat: { id: 10 },
      from: { id: 100, first_name: "M" },
      text: "/admin_release_preview@MoneyFlowBot"
    }
  });

  assert.match(messages[0].text, /Пользователям будет отправлено/);
  assert.match(messages[0].text, /Скрыто из пользовательского пуша/);
});

test("admin release send returns summary", async () => {
  const messages = [];
  const bot = createTelegramBot({
    token: "test-token",
    miniAppUrl: "http://localhost:3000",
    repository: fakeRepository(),
    adminTelegramIds: new Set([100]),
    releaseNotesService: fakeReleaseNotesService({
      sendResult: {
        sent: true,
        version: "v.1.18",
        users: 12,
        success: 11,
        errors: 1,
        blocked: 1
      }
    }),
    telegramClient: captureTelegramClient(messages)
  });

  await bot.handleUpdate({
    message: {
      chat: { id: 10 },
      from: { id: 100, first_name: "M" },
      text: "/admin_release_send@MoneyFlowBot"
    }
  });

  assert.match(messages[0].text, /Release digest отправлен/);
  assert.match(messages[0].text, /Версия: v\.1\.18/);
  assert.match(messages[0].text, /Пользователей: 12/);
  assert.match(messages[0].text, /Заблокировали бота: 1/);
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

  assert.equal(messages[0].text, "Сегодня нет публичных release notes для пользователей — отправлять нечего.");
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
    async previewTodayReleaseDigest() {
      return {
        text: options.previewText ?? "Сегодня нет release notes — пуш пользователям отправляться не будет."
      };
    },
    async sendTodayReleaseDigest() {
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
