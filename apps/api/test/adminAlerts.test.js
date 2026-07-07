import test from "node:test";
import assert from "node:assert/strict";

import {
  createAdminAlertService,
  formatAdminAlertMessage,
  sanitizeAlertContext,
  serializeAlertError
} from "../src/adminAlerts.js";

test("notifyAdminError sends one compact alert to every configured admin", async () => {
  const sent = [];
  const service = createAdminAlertService({
    enabled: true,
    adminTelegramIds: new Set([100, 200]),
    now: () => new Date("2026-07-07T14:30:00.000Z"),
    sendMessage: async (message) => sent.push(message)
  });

  await service.notifyAdminError(new TypeError("Invalid expense payload"), {
    source: "api",
    method: "POST",
    route: "/api/expenses",
    userId: "redacted-user"
  });

  assert.deepEqual(sent.map((message) => message.chatId), [100, 200]);
  assert.match(sent[0].text, /^Money Flow error/);
  assert.match(sent[0].text, /source: api/);
  assert.match(sent[0].text, /route: POST \/api\/expenses/);
  assert.match(sent[0].text, /userId: redacted-user/);
  assert.match(sent[0].text, /error: TypeError/);
  assert.match(sent[0].text, /message: Invalid expense payload/);
  assert.match(sent[0].text, /time: 2026-07-07T14:30:00.000Z/);
  assert.equal(sent[0].replyMarkup, null);
});

test("notifyAdminError skips sending when disabled or no admins are configured", async () => {
  const sent = [];

  await createAdminAlertService({
    enabled: false,
    adminTelegramIds: new Set([100]),
    sendMessage: async (message) => sent.push(message)
  }).notifyAdminError(new Error("boom"), { source: "api" });

  await createAdminAlertService({
    enabled: true,
    adminTelegramIds: new Set(),
    sendMessage: async (message) => sent.push(message)
  }).notifyAdminError(new Error("boom"), { source: "api" });

  assert.deepEqual(sent, []);
});

test("notifyAdminError throttles repeated alerts with the same fingerprint", async () => {
  const sent = [];
  let current = new Date("2026-07-07T14:30:00.000Z");
  const service = createAdminAlertService({
    enabled: true,
    adminTelegramIds: new Set([100]),
    throttleMs: 600_000,
    now: () => current,
    sendMessage: async (message) => sent.push(message)
  });
  const error = new Error("database unavailable for user 12345");
  const context = { source: "api", method: "GET", route: "/api/dashboard" };

  await service.notifyAdminError(error, context);
  await service.notifyAdminError(error, context);
  current = new Date("2026-07-07T14:41:00.000Z");
  await service.notifyAdminError(error, context);

  assert.equal(sent.length, 2);
});

test("notifyAdminError sends different fingerprints separately", async () => {
  const sent = [];
  const service = createAdminAlertService({
    enabled: true,
    adminTelegramIds: new Set([100]),
    now: () => new Date("2026-07-07T14:30:00.000Z"),
    sendMessage: async (message) => sent.push(message)
  });

  await service.notifyAdminError(new Error("failed"), { source: "api", route: "/api/dashboard" });
  await service.notifyAdminError(new Error("failed"), { source: "scheduler", jobName: "daily-reminder" });

  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /source: api/);
  assert.match(sent[1].text, /source: scheduler/);
});

test("sanitizeAlertContext removes sensitive fields recursively and keeps safe scalar context", () => {
  const sanitized = sanitizeAlertContext({
    source: "api",
    route: "/api/expenses",
    method: "POST",
    telegramUserId: 123,
    userId: "456",
    operation: "create_expense",
    token: "secret-token",
    nestedSecret: { password: "secret" },
    headers: { authorization: "Bearer secret" },
    body: { amount: 100 },
    extra: {
      safeFlag: true,
      initData: "query_id=secret",
      signature: "abc",
      hash: "hash",
      env: { OPENAI_API_KEY: "secret" },
      count: 2
    }
  });

  assert.deepEqual(sanitized, {
    source: "api",
    route: "/api/expenses",
    method: "POST",
    telegramUserId: 123,
    userId: "456",
    operation: "create_expense",
    extra: {
      safeFlag: true,
      count: 2
    }
  });
});

test("formatAdminAlertMessage truncates long output without exposing stack traces", () => {
  const text = formatAdminAlertMessage(
    {
      name: "Error",
      message: "x".repeat(200),
      stackFirstLine: "Error: x"
    },
    { source: "api", route: "/api/expenses", method: "POST" },
    { now: new Date("2026-07-07T14:30:00.000Z"), maxMessageLength: 120 }
  );

  assert.ok(text.length <= 120);
  assert.match(text, /^Money Flow error/);
  assert.doesNotMatch(text, /stack/i);
  assert.match(text, /\.\.\.$/);
});

test("serializeAlertError handles non-Error values safely", () => {
  assert.deepEqual(serializeAlertError("plain failure"), {
    name: "NonError",
    message: "plain failure"
  });
  assert.deepEqual(serializeAlertError(null), {
    name: "NonError",
    message: "null"
  });
});

test("notifyAdminError logs and absorbs Telegram send failures without recursion", async () => {
  const errors = [];
  let sendAttempts = 0;
  const service = createAdminAlertService({
    enabled: true,
    adminTelegramIds: new Set([100, 200]),
    logger: {
      error(message, metadata) {
        errors.push({ message, metadata });
      }
    },
    sendMessage: async () => {
      sendAttempts += 1;
      throw new Error("telegram unavailable");
    }
  });

  await assert.doesNotReject(
    service.notifyAdminError(new Error("primary failure"), { source: "api" })
  );

  assert.equal(sendAttempts, 2);
  assert.equal(errors.length, 2);
  assert.match(errors[0].message, /admin alert send failed/);
  assert.equal(errors[0].metadata.chatId, 100);
  assert.equal(errors[0].metadata.errorName, "Error");
});
