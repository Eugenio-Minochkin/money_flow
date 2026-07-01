import test from "node:test";
import assert from "node:assert/strict";

import { monthlyReportKeyboard, weeklyReportKeyboard } from "../src/reportKeyboards.js";

test("weekly report keyboard opens selected week and add-expense flow", () => {
  const keyboard = weeklyReportKeyboard("http://localhost:3000", 100, "2026-W25", "en");
  const buttons = keyboard.inline_keyboard.flat();

  assert.equal(buttons[0].text, "Open week");
  assert.equal(buttons[0].web_app.url, "http://localhost:3000?telegramUserId=100&view=history&period=week&periodKey=2026-W25");
  assert.equal(buttons[1].text, "Add expense");
  assert.equal(buttons[1].web_app.url, "http://localhost:3000?telegramUserId=100&action=addExpense");
});

test("monthly report keyboard opens selected month and budget screen in Russian", () => {
  const keyboard = monthlyReportKeyboard("http://localhost:3000", 100, "2026-06", "ru");
  const buttons = keyboard.inline_keyboard.flat();

  assert.equal(buttons[0].text, "Открыть месяц");
  assert.equal(buttons[0].web_app.url, "http://localhost:3000?telegramUserId=100&view=history&period=month&periodKey=2026-06");
  assert.equal(buttons[1].text, "Бюджет на новый месяц");
  assert.equal(buttons[1].web_app.url, "http://localhost:3000?telegramUserId=100&view=settings&focus=budget");
});
