import assert from "node:assert/strict";
import test from "node:test";

import { deliverShortcutCaptureToTelegram, deliverShortcutCaptureToTelegramBestEffort } from "../src/telegram.js";

const user = { telegram_user_id: 100, interface_language: "ru" };
const expense = { id: 91, amount_base: 180, amount_original: 180, currency_original: "THB", description: "Coffee", category_slug: "food_cafe" };

function dependencies() {
  const sent = [];
  const refs = [];
  return {
    sent,
    refs,
    repository: {
      async setDraftMessageRef(...args) { refs.push(args); }
    },
    sendMessage: async (message) => { sent.push(message); return { ok: true, result: { message_id: 444 } }; }
  };
}

test("Shortcut saved result reuses the regular saved-expense card exactly once", async () => {
  const setup = dependencies();
  await deliverShortcutCaptureToTelegram({
    result: { state: "saved", expense, draft: { id: 41 }, dashboardSnapshot: null, replayed: false },
    user,
    miniAppUrl: "https://mini.example",
    ...setup
  });

  assert.equal(setup.sent.length, 1);
  assert.match(setup.sent[0].text, /Coffee/);
  assert.match(setup.sent[0].text, /180/);
  assert.deepEqual(setup.refs, [[41, 100, 100, 444]]);
});

test("Shortcut review result reuses the regular draft preview and confirmation controls", async () => {
  const setup = dependencies();
  await deliverShortcutCaptureToTelegram({
    result: {
      state: "review",
      draft: { id: 41, items: [{ amount: 180, currency: "THB", description: "Coffee", category_slug: "other", needs_review: true }] },
      replayed: false
    },
    user,
    miniAppUrl: "https://mini.example",
    ...setup
  });

  assert.equal(setup.sent.length, 1);
  assert.match(setup.sent[0].text, /Coffee/);
  assert.deepEqual(setup.refs, [[41, 100, 100, 444]]);
  assert.ok(setup.sent[0].replyMarkup.inline_keyboard.flat().some((button) => /confirm/i.test(button.callback_data)));
});

test("Shortcut replay does not send or reference another Telegram message", async () => {
  const setup = dependencies();
  await deliverShortcutCaptureToTelegram({ result: { state: "saved", expense, draft: { id: 41 }, replayed: true }, user, miniAppUrl: "https://mini.example", ...setup });
  assert.deepEqual(setup.sent, []);
  assert.deepEqual(setup.refs, []);
});

test("Shortcut Telegram delivery failure is best-effort and preserves the saved response", async () => {
  const errors = [];
  const result = { state: "saved", expense, draft: { id: 41 }, replayed: false };
  const delivered = await deliverShortcutCaptureToTelegramBestEffort({
    result,
    user,
    miniAppUrl: "https://mini.example",
    repository: { async setDraftMessageRef() {} },
    sendMessage: async () => { throw new Error("telegram unavailable"); },
    onError: (error) => errors.push(error.message)
  });

  assert.equal(delivered, null);
  assert.equal(result.state, "saved");
  assert.deepEqual(errors, ["telegram unavailable"]);
});
