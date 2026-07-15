import test from "node:test";
import assert from "node:assert/strict";

import { buildTelegramCommandMenu, syncTelegramCommandMenu } from "../src/telegramCommands.js";

test("command menu includes feedback, last, and export", () => {
  const commands = buildTelegramCommandMenu();

  assert.ok(commands.some((command) => command.command === "feedback"));
  assert.ok(commands.some((command) => command.command === "export"));
  assert.ok(commands.some((command) => command.command === "last"));
});

test("default command descriptions are English", () => {
  const commands = buildTelegramCommandMenu();

  assert.ok(commands.length > 0);
  assert.equal(commands.some((command) => /[а-яё]/iu.test(command.description)), false);
});

test("syncTelegramCommandMenu sets default English and Russian language-scoped commands", async () => {
  const calls = [];
  const telegramClient = {
    async setMyCommands(payload) {
      calls.push(payload);
      return { ok: true };
    }
  };

  await syncTelegramCommandMenu({ token: "test-token", telegramClient });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { commands: buildTelegramCommandMenu() });
  assert.equal(calls[1].languageCode, "ru");
  assert.ok(calls[1].commands.some((command) => command.command === "feedback"));
  assert.equal(calls[1].commands.some((command) => /[а-яё]/iu.test(command.description)), true);
});
