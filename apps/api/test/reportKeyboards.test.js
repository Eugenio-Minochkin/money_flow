import test from "node:test";
import assert from "node:assert/strict";

import { monthlyReportKeyboard, weeklyReportKeyboard } from "../src/reportKeyboards.js";

test("weekly report keyboard opens the exact closed week with one primary button", () => {
  const keyboard = weeklyReportKeyboard("http://localhost:3000", 100, {
    periodKey: "2026-W25",
    localStartDate: "2026-06-15",
    localEndDate: "2026-06-21"
  }, "en");
  const buttons = keyboard.inline_keyboard.flat();

  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].text, "Open week");
  assert.equal(buttons[0].style, "primary");
  assert.equal(buttons[0].web_app.url, "http://localhost:3000/?telegramUserId=100&view=history&period=custom&fromDate=2026-06-15&toDate=2026-06-21&launchSource=report&reportType=weekly&reportKey=2026-W25");
});

test("monthly report keyboard opens the exact closed month and preserves budget settings", () => {
  const keyboard = monthlyReportKeyboard("http://localhost:3000", 100, {
    periodKey: "2026-06",
    localStartDate: "2026-06-01",
    localEndDate: "2026-06-30"
  }, "ru");
  const buttons = keyboard.inline_keyboard.flat();

  assert.equal(buttons[0].text, "Открыть месяц");
  assert.equal(buttons[0].style, "primary");
  assert.equal(buttons[0].web_app.url, "http://localhost:3000/?telegramUserId=100&view=history&period=month&monthKey=2026-06&fromDate=2026-06-01&toDate=2026-06-30&launchSource=report&reportType=monthly&reportKey=2026-06");
  assert.equal(buttons[1].text, "Бюджет на новый месяц");
  assert.equal(buttons[1].style, "primary");
  assert.equal(buttons[1].web_app.url, "http://localhost:3000?telegramUserId=100&view=settings&focus=budget");
});
