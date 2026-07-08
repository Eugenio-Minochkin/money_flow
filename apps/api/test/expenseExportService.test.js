import test from "node:test";
import assert from "node:assert/strict";

import { createExpenseExportService } from "../src/expenseExportService.js";

test("requestExport sends confirmed expense CSV with safe columns", async () => {
  const documents = [];
  const service = createExpenseExportService({
    now: () => new Date("2026-07-08T12:00:00Z"),
    repository: pagedRepository([
      [{
        amount_original: "250",
        currency_original: "THB",
        description: "кофе, \"утро\"",
        category_slug: "food_cafe",
        spent_at: "2026-07-07T21:30:00Z",
        created_at: "2026-07-07T21:31:05Z",
        display: { amount: 7.69, currency: "USD" },
        user_id: 7,
        telegram_user_id: 100,
        initData: "secret"
      }]
    ]),
    sendDocument: async (document) => documents.push(document)
  });

  const result = await service.requestExport({
    telegramUserId: 100,
    chatId: 500,
    period: "month",
    language: "en"
  });

  assert.equal(result.status, "sent");
  assert.equal(documents.length, 1);
  assert.equal(documents[0].chatId, 500);
  assert.equal(documents[0].filename, "money-flow-export-2026-07.csv");
  assert.match(documents[0].caption, /CSV/);
  const csv = documents[0].content.toString("utf8");
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv, /^﻿date,amount,currency,amount_display,display_currency,category,note,type,created_at\r\n/);
  assert.match(csv, /2026-07-07,250,THB,7.69,USD,food_cafe,"кофе, ""утро""",expense,2026-07-07 21:31:05/);
  assert.doesNotMatch(csv, /telegram_user_id|user_id|initData|secret|100/);
});

test("requestExport paginates all rows and uses all-time filename", async () => {
  const seen = [];
  const documents = [];
  const service = createExpenseExportService({
    repository: {
      async listExpenseExportRowsForTelegramUser(telegramUserId, options) {
        seen.push({ telegramUserId, options });
        if (options.offset === 0) return [row("2026-01-01T00:00:00Z")];
        if (options.offset === 1) return [row("2026-01-02T00:00:00Z")];
        return [];
      }
    },
    sendDocument: async (document) => documents.push(document),
    pageSize: 1
  });

  const result = await service.requestExport({ telegramUserId: 100, chatId: 500, period: "all", language: "ru" });

  assert.equal(result.status, "sent");
  assert.equal(documents[0].filename, "money-flow-export-all.csv");
  assert.equal((documents[0].content.toString("utf8").match(/expense/g) ?? []).length, 2);
  assert.deepEqual(seen.map((call) => call.options.offset), [0, 1, 2]);
});

test("requestExport returns empty without sending a document", async () => {
  const documents = [];
  const service = createExpenseExportService({
    repository: pagedRepository([[]]),
    sendDocument: async (document) => documents.push(document)
  });

  const result = await service.requestExport({ telegramUserId: 100, chatId: 500, period: "month", language: "ru" });

  assert.deepEqual(result, {
    status: "empty",
    message: "За выбранный период расходов нет."
  });
  assert.equal(documents.length, 0);
});

test("requestExport throttles per user across periods", async () => {
  const service = createExpenseExportService({
    now: steppedNow([
      "2026-07-08T12:00:00Z",
      "2026-07-08T12:00:10Z",
      "2026-07-08T12:02:01Z"
    ]),
    repository: pagedRepository([[row("2026-07-07T21:30:00Z")], [], [row("2026-07-07T21:30:00Z")]]),
    sendDocument: async () => {},
    cooldownMs: 120000
  });

  assert.equal((await service.requestExport({ telegramUserId: 100, chatId: 1, period: "month" })).status, "sent");
  assert.deepEqual(await service.requestExport({ telegramUserId: 100, chatId: 1, period: "all" }), {
    status: "throttled",
    message: "Export is already running or was just requested. Please try again later."
  });
  assert.equal((await service.requestExport({ telegramUserId: 100, chatId: 1, period: "all" })).status, "sent");
});

function pagedRepository(pages) {
  return {
    async listExpenseExportRowsForTelegramUser(_telegramUserId, options) {
      return pages[options.offset] ?? [];
    }
  };
}

function row(spentAt) {
  return {
    amount_original: "10",
    currency_original: "THB",
    description: "coffee",
    category_slug: "food_cafe",
    spent_at: spentAt,
    created_at: spentAt,
    display: { amount: 0.31, currency: "USD" }
  };
}

function steppedNow(values) {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]);
}
