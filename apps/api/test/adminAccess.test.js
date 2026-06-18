import test from "node:test";
import assert from "node:assert/strict";

import {
  isAdminTelegramId,
  normalizeBotCommand,
  parseAdminTelegramIds
} from "../src/adminAccess.js";

test("parses common ADMIN_TELEGRAM_IDS formats", () => {
  const formats = [
    "123456789",
    "123456789,987654321",
    "123456789 987654321",
    "123456789;987654321",
    "\"123456789\"",
    "[123456789, 987654321]"
  ];

  assert.deepEqual(parseAdminTelegramIds(formats[0]), new Set([123456789]));
  for (const value of formats.slice(1, 4)) {
    assert.deepEqual(parseAdminTelegramIds(value), new Set([123456789, 987654321]));
  }
  assert.deepEqual(parseAdminTelegramIds(formats[4]), new Set([123456789]));
  assert.deepEqual(parseAdminTelegramIds(formats[5]), new Set([123456789, 987654321]));
});

test("ignores unsafe admin id values without extracting embedded digits", () => {
  assert.deepEqual(
    parseAdminTelegramIds("@name bad 0 -1 1.5 9007199254740992 user123 456"),
    new Set([456])
  );
  assert.deepEqual(parseAdminTelegramIds(""), new Set());
  assert.deepEqual(parseAdminTelegramIds(undefined), new Set());
});

test("checks numeric and numeric-string caller ids against parsed admins", () => {
  const admins = new Set([123456789]);

  assert.equal(isAdminTelegramId(123456789, admins), true);
  assert.equal(isAdminTelegramId("123456789", admins), true);
  assert.equal(isAdminTelegramId("@123456789", admins), false);
  assert.equal(isAdminTelegramId(0, admins), false);
  assert.equal(isAdminTelegramId(123456789, ["123456789"]), false);
});

test("normalizes Telegram bot command suffixes only for valid commands", () => {
  assert.equal(normalizeBotCommand("/admin_stats"), "/admin_stats");
  assert.equal(normalizeBotCommand(" /admin_stats@SomeBot "), "/admin_stats");
  assert.equal(normalizeBotCommand("/admin_release_preview@money_flow_bot"), "/admin_release_preview");
  assert.equal(normalizeBotCommand("/admin_release_send@Bot123"), "/admin_release_send");
  assert.equal(normalizeBotCommand("coffee@shop 100"), "coffee@shop 100");
  assert.equal(normalizeBotCommand("/admin_stats extra"), "/admin_stats extra");
  assert.equal(normalizeBotCommand(null), null);
});
