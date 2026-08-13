import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTelegramCommandMenu,
  syncTelegramCommandMenu,
  syncTelegramUserCommandMenu
} from "../src/telegramCommands.js";

test("completed-user command menu contains only compact daily actions", () => {
  const commands = buildTelegramCommandMenu();

  assert.deepEqual(commands.map((command) => command.command), [
    "today", "week", "month", "budget", "last", "export", "feedback", "help"
  ]);
  assert.equal(commands.find((command) => command.command === "today").description, "📌 Today's spending");
  assert.equal(commands.find((command) => command.command === "help").description, "❓ How to use Money Flow");
});

test("onboarding command menu keeps start without restoring hidden technical commands", () => {
  const commands = buildTelegramCommandMenu("ru", { onboarding: true });

  assert.deepEqual(commands.map((command) => command.command), [
    "start", "today", "week", "month", "budget", "last", "export", "feedback", "help"
  ]);
  assert.equal(commands.find((command) => command.command === "today").description, "📌 Расходы сегодня");
  assert.equal(commands.find((command) => command.command === "help").description, "❓ Как пользоваться");
  assert.equal(commands.some((command) => ["app", "settings", "delete_me"].includes(command.command)), false);
});

test("default command descriptions are English", () => {
  const commands = buildTelegramCommandMenu();

  assert.ok(commands.length > 0);
  assert.equal(commands.some((command) => /[а-яё]/iu.test(command.description)), false);
});

test("syncTelegramCommandMenu keeps onboarding fallbacks and restores the commands menu button", async () => {
  const calls = [];
  const telegramClient = {
    async setMyCommands(payload) {
      calls.push({ method: "setMyCommands", payload });
      return { ok: true };
    },
    async setChatMenuButton(payload) {
      calls.push({ method: "setChatMenuButton", payload });
      return { ok: true };
    }
  };

  await syncTelegramCommandMenu({ token: "test-token", telegramClient });

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].payload, { commands: buildTelegramCommandMenu("en", { onboarding: true }) });
  assert.equal(calls[1].payload.languageCode, "ru");
  assert.ok(calls[1].payload.commands.some((command) => command.command === "start"));
  assert.deepEqual(calls[2], {
    method: "setChatMenuButton",
    payload: { menuButton: { type: "commands" } }
  });
});

test("syncTelegramUserCommandMenu uses Money Flow language in a private-chat scope", async () => {
  const calls = [];
  const telegramClient = {
    async setMyCommands(payload) {
      calls.push({ method: "setMyCommands", payload });
      return { ok: true };
    },
    async setChatMenuButton(payload) {
      calls.push({ method: "setChatMenuButton", payload });
      return { ok: true };
    }
  };

  await syncTelegramUserCommandMenu({
    token: "test-token",
    telegramClient,
    chatId: 100,
    language: "ru",
    onboardingStep: "completed"
  });

  assert.deepEqual(calls[0], {
    method: "setMyCommands",
    payload: {
      commands: buildTelegramCommandMenu("ru"),
      scope: { type: "chat", chatId: 100 }
    }
  });
  assert.deepEqual(calls[1], {
    method: "setChatMenuButton",
    payload: { chatId: 100, menuButton: { type: "commands" } }
  });
  assert.equal(calls[0].payload.commands.some((command) => command.command === "start"), false);
});

test("syncTelegramUserCommandMenu includes start until onboarding is complete", async () => {
  const calls = [];
  await syncTelegramUserCommandMenu({
    token: "test-token",
    chatId: 100,
    language: "en",
    onboardingStep: "budget_setup",
    telegramClient: {
      async setMyCommands(payload) { calls.push(payload); return { ok: true }; },
      async setChatMenuButton() { return { ok: true }; }
    }
  });

  assert.equal(calls[0].commands.some((command) => command.command === "start"), true);
});

test("personal command sync sends BotCommandScopeChat and a commands menu button to Telegram", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, async json() { return { ok: true }; } };
  };

  await syncTelegramUserCommandMenu({
    token: "test-token",
    fetchImpl,
    chatId: 123,
    language: "en",
    onboardingStep: "completed"
  });

  assert.match(requests[0].url, /\/setMyCommands$/);
  assert.deepEqual(requests[0].body.scope, { type: "chat", chat_id: 123 });
  assert.equal("language_code" in requests[0].body, false);
  assert.match(requests[1].url, /\/setChatMenuButton$/);
  assert.deepEqual(requests[1].body, {
    chat_id: 123,
    menu_button: { type: "commands" }
  });
});
