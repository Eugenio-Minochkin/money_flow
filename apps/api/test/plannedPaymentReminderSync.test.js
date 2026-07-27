import test from "node:test";
import assert from "node:assert/strict";

import { updatePlannedPaymentReminderMessages } from "../src/telegram.js";

test("Mini App planned mutation clears outstanding Telegram buttons best-effort", async () => {
  const calls = [];
  await updatePlannedPaymentReminderMessages({
    token: "token",
    reminders: [
      { tg_chat_id: 100, tg_message_id: 10, interface_language: "ru" },
      { tg_chat_id: 100, tg_message_id: 11, interface_language: "en" }
    ],
    outcome: "paid",
    telegramClient: {
      async editMessageText(message) {
        calls.push(message);
        if (message.messageId === 10) throw new Error("old message unavailable");
        return { ok: true };
      }
    }
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].text, /Mini App/);
  assert.deepEqual(calls[1].replyMarkup, { inline_keyboard: [] });
});
