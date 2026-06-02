import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createApiSecurity } from "../src/apiSecurity.js";
import { createRateLimiter } from "../src/rateLimit.js";
import { verifyTelegramInitData } from "../src/telegramAuth.js";

test("verifies Telegram Mini App init data and returns the user id", () => {
  const botToken = "123456:test-token";
  const authDate = String(Math.floor(new Date("2026-06-02T10:00:00Z").getTime() / 1000));
  const user = JSON.stringify({ id: 100, first_name: "M" });
  const initData = signInitData({ auth_date: authDate, user }, botToken);

  const result = verifyTelegramInitData(initData, botToken, { now: new Date("2026-06-02T10:00:00Z") });

  assert.equal(result.ok, true);
  assert.equal(result.telegramUserId, 100);
});

test("rejects tampered Telegram Mini App init data", () => {
  const botToken = "123456:test-token";
  const authDate = String(Math.floor(new Date("2026-06-02T10:00:00Z").getTime() / 1000));
  const initData = signInitData({ auth_date: authDate, user: JSON.stringify({ id: 100 }) }, botToken);

  const result = verifyTelegramInitData(initData.replace("100", "101"), botToken, { now: new Date("2026-06-02T10:00:00Z") });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_hash");
});

test("rate limiter allows requests until the limit and then blocks", () => {
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000 });

  assert.equal(limiter.check("user:1", 0).allowed, true);
  assert.equal(limiter.check("user:1", 100).allowed, true);
  const blocked = limiter.check("user:1", 200);

  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 1);
  assert.equal(limiter.check("user:1", 1200).allowed, true);
});

test("API security rejects direct Mini App user ids when strict auth is enabled", () => {
  const security = createApiSecurity({
    telegramBotToken: "123456:test-token",
    requireTelegramInitData: true,
    telegramWebhookSecret: "webhook-secret"
  });
  const req = { headers: {} };
  const url = new URL("http://localhost/api/dashboard?telegramUserId=100");

  const result = security.resolveTelegramUserId(req, url);

  assert.deepEqual(result, { error: "telegram_init_data_required" });
});

test("API security accepts signed Mini App init data and rejects mismatched declared ids", () => {
  const botToken = "123456:test-token";
  const authDate = String(Math.floor(Date.now() / 1000));
  const initData = signInitData({ auth_date: authDate, user: JSON.stringify({ id: 100 }) }, botToken);
  const security = createApiSecurity({
    telegramBotToken: botToken,
    requireTelegramInitData: true
  });
  const req = { headers: { "x-telegram-init-data": initData } };

  assert.deepEqual(
    security.resolveTelegramUserId(req, new URL("http://localhost/api/dashboard?telegramUserId=100")),
    { telegramUserId: 100 }
  );
  assert.deepEqual(
    security.resolveTelegramUserId(req, new URL("http://localhost/api/dashboard?telegramUserId=101")),
    { error: "telegram_user_mismatch" }
  );
});

test("API security validates Telegram webhook secret when configured", () => {
  const security = createApiSecurity({
    telegramBotToken: "123456:test-token",
    telegramWebhookSecret: "webhook-secret"
  });

  assert.equal(security.isValidTelegramWebhook({ headers: {} }), false);
  assert.equal(security.isValidTelegramWebhook({ headers: { "x-telegram-bot-api-secret-token": "wrong" } }), false);
  assert.equal(security.isValidTelegramWebhook({ headers: { "x-telegram-bot-api-secret-token": "webhook-secret" } }), true);
});

function signInitData(params, botToken) {
  const data = new URLSearchParams(params);
  const checkString = [...data.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = crypto.createHmac("sha256", secret).update(checkString).digest("hex");
  data.set("hash", hash);
  return data.toString();
}
