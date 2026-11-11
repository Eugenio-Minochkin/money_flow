import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { buildConfig } from "../src/config.js";
import { formatWeeklyReportWidget } from "../src/reportFormat.js";
import { sendTelegramWidget } from "../src/telegram.js";

const report = {
  period: { localStartDate: "2026-11-02", localEndDate: "2026-11-08" },
  currency: "THB",
  metrics: { totalSpent: 6840, averagePerDay: 977 },
  comparison: { available: true, direction: "down", percentDelta: 12 },
  topCategories: [{ name: "Еда <дом>", amount: 2420, percent: 35.4 }],
  changes: [{ name: "Еда <дом>", direction: "down", percentDelta: 18 }],
  needsAttention: { count: 1, shown: [{ name: "Интернет", amount: 400, dueDate: "2026-11-06" }] }
};

test("weekly report widgets are enabled by default and can be disabled", () => {
  assert.equal(buildConfig({}).weeklyReportWidgetEnabled, true);
  assert.equal(buildConfig({ TELEGRAM_WEEKLY_REPORT_WIDGET_ENABLED: "false" }).weeklyReportWidgetEnabled, false);
});

test("weekly widget keeps the summary and payment notice in its caption and private chart data out of the HTML", () => {
  const { html, caption, chatData } = formatWeeklyReportWidget(report, { language: "ru" });
  assert.match(caption, /2–8 ноября[\s\S]+6 840 THB[\s\S]+12%/);
  assert.match(caption, /Интернет — 400 THB[\s\S]+6 ноября/);
  assert.doesNotMatch(html, /6 840|Еда|Интернет/);
  assert.deepEqual(JSON.parse(chatData).categories, [{ name: "Еда <дом>", amount: "2 420 THB", percent: 35 }]);
  assert.deepEqual(JSON.parse(chatData).changes, ["Еда <дом> — на 18% меньше"]);
  assert.ok(Buffer.byteLength(html) <= 32768);
  assert.ok(deflateSync(html, { level: 9 }).length <= 4096);
});

test("weekly widget has no changes in a first week and uses the text format for unsupported payloads", () => {
  const { chatData, caption } = formatWeeklyReportWidget({ ...report, firstWeek: true, comparison: {}, changes: [] }, { language: "en" });
  assert.deepEqual(JSON.parse(chatData).changes, []);
  assert.match(caption, /Your first week/);
  assert.equal(formatWeeklyReportWidget({ ...report, topCategories: [] }), null);
  assert.equal(formatWeeklyReportWidget({ ...report, takeaway: "a".repeat(1025) }), null);
  assert.equal(formatWeeklyReportWidget({ ...report, topCategories: [{ name: "я".repeat(600), amount: 1 }] }), null);
});

test("weekly widget shows the five biggest categories and expenses and keeps the detail sections", () => {
  const { caption, chatData } = formatWeeklyReportWidget({
    ...report,
    metrics: { ...report.metrics, display: { totalSpent: 209.45, currency: "USD" } },
    topCategories: ["Еда", "Транспорт", "Здоровье", "Покупки", "Дом", "Другое"].map((name, index) => ({
      name, amount: 1200 - index * 100, percent: 18 - index
    })),
    largestExpenses: ["Отель", "Кроссовки", "Такси", "Ужин", "Аптека", "Кофе"].map((name, index) => ({
      name, amount: 600 - index * 100
    }))
  });
  const data = JSON.parse(chatData);

  assert.deepEqual(data.categories.map(({ name }) => name), ["Еда", "Транспорт", "Здоровье", "Покупки", "Дом"]);
  assert.deepEqual(data.largestExpenses.map(({ name }) => name), ["Отель", "Кроссовки", "Такси", "Ужин", "Аптека"]);
  assert.equal(data.largestExpenses[0].amount, "600 THB");
  assert.deepEqual(data.changes, ["Еда <дом> — на 18% меньше"]);
  assert.match(caption, /209,45 USD[\s\S]+Интернет — 400 THB/);
  assert.doesNotMatch(caption, /Отель/);
});

test("sendTelegramWidget posts a protected widget with private state and the original inline keyboard", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true, result: { message_id: 25 } }));
  const widget = formatWeeklyReportWidget(report);
  const replyMarkup = { inline_keyboard: [[{ text: "Open week", web_app: { url: "https://example.test" } }]] };
  const response = await sendTelegramWidget({ token: "test-token", chatId: 101, replyMarkup, ...widget });
  const [url, request] = fetch.mock.calls[0].arguments;

  assert.equal(response.result.message_id, 25);
  assert.equal(url, "https://api.telegram.org/bottest-token/sendWidget");
  assert.equal(request.method, "POST");
  assert.deepEqual(JSON.parse(request.body), {
    chat_id: 101,
    html: widget.html,
    caption: widget.caption,
    chat_data: widget.chatData,
    parse_mode: "HTML",
    show_caption_above_media: true,
    protect_content: true,
    reply_markup: replyMarkup
  });
});
