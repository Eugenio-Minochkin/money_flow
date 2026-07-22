import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";

import { createApiSecurity } from "../src/apiSecurity.js";
import { buildConfig, requireRuntimeConfig } from "../src/config.js";
import { createRateLimiter, getRateLimitKey } from "../src/rateLimit.js";
import { shouldRateLimitRequest } from "../src/routing.js";
import { verifyTelegramInitData } from "../src/telegramAuth.js";

test("verifies Telegram Mini App init data and returns the signed profile and start parameter", () => {
  const botToken = "123456:test-token";
  const authDate = String(Math.floor(new Date("2026-06-02T10:00:00Z").getTime() / 1000));
  const user = JSON.stringify({ id: 100, first_name: "M", username: "mino" });
  const initData = signInitData({ auth_date: authDate, user, start_param: "expat_cm" }, botToken);

  const result = verifyTelegramInitData(initData, botToken, { now: new Date("2026-06-02T10:00:00Z") });

  assert.equal(result.ok, true);
  assert.equal(result.telegramUserId, 100);
  assert.deepEqual(result.profile, { id: 100, firstName: "M", username: "mino" });
  assert.equal(result.startParam, "expat_cm");
});

test("rejects tampered Telegram Mini App init data", () => {
  const botToken = "123456:test-token";
  const authDate = String(Math.floor(new Date("2026-06-02T10:00:00Z").getTime() / 1000));
  const initData = signInitData({ auth_date: authDate, user: JSON.stringify({ id: 100 }) }, botToken);

  const result = verifyTelegramInitData(initData.replace("100", "101"), botToken, { now: new Date("2026-06-02T10:00:00Z") });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_hash");
});

test("does not expose profile or start parameter from expired init data", () => {
  const botToken = "123456:test-token";
  const authDate = String(Math.floor(new Date("2026-06-01T08:00:00Z").getTime() / 1000));
  const initData = signInitData({
    auth_date: authDate,
    user: JSON.stringify({ id: 100, first_name: "M" }),
    start_param: "expat_cm"
  }, botToken);

  const result = verifyTelegramInitData(initData, botToken, { now: new Date("2026-06-02T10:00:00Z") });

  assert.deepEqual(result, { ok: false, reason: "expired" });
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

test("rate limiter keeps different Telegram users in separate buckets", () => {
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000 });

  assert.equal(limiter.check("tg:111", 0).allowed, true);
  assert.equal(limiter.check("tg:111", 100).allowed, true);

  assert.equal(limiter.check("tg:222", 200).allowed, true);
});

test("rate limiter removes buckets that have not been seen within the TTL", () => {
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000, bucketTtlMs: 5000 });

  limiter.check("tg:111", 0);
  limiter.check("tg:222", 4500);
  const removed = limiter.cleanupStaleBuckets(6000);

  assert.equal(removed, 1);
  assert.equal(limiter.bucketCount(), 1);
  assert.equal(limiter.check("tg:111", 6100).allowed, true);
});

test("rate limit key prefers Telegram user id over client IP", () => {
  const req = { socket: { remoteAddress: "10.0.0.5" }, headers: {} };

  assert.equal(
    getRateLimitKey(req, { telegramUserId: 111, trustedProxyIps: [] }),
    "tg:111"
  );
});

test("rate limit key ignores X-Forwarded-For from untrusted clients", () => {
  const req = {
    socket: { remoteAddress: "10.0.0.5" },
    headers: { "x-forwarded-for": "1.2.3.4" }
  };

  assert.equal(
    getRateLimitKey(req, { trustedProxyIps: ["127.0.0.1"] }),
    "ip:10.0.0.5"
  );
});

test("rate limit key uses first X-Forwarded-For IP from trusted proxies", () => {
  const req = {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { "x-forwarded-for": "203.0.113.10, 10.0.0.1" }
  };

  assert.equal(
    getRateLimitKey(req, { trustedProxyIps: ["127.0.0.1"] }),
    "ip:203.0.113.10"
  );
});

test("rate limiter applies to API and webhook but not Mini App static files", () => {
  assert.equal(shouldRateLimitRequest({ method: "GET" }, new URL("http://localhost/")), false);
  assert.equal(shouldRateLimitRequest({ method: "GET" }, new URL("http://localhost/app.js")), false);
  assert.equal(shouldRateLimitRequest({ method: "GET" }, new URL("http://localhost/api/dashboard")), true);
  assert.equal(shouldRateLimitRequest({ method: "POST" }, new URL("http://localhost/telegram/webhook")), true);
});

test("API security accepts valid Telegram init data", () => {
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
    {
      telegramUserId: 100,
      verified: true,
      profile: { id: 100, firstName: null, username: null },
      startParam: null
    }
  );
});

test("API security can resolve verified Telegram user id while ignoring request ids", () => {
  const botToken = "123456:test-token";
  const authDate = String(Math.floor(Date.now() / 1000));
  const initData = signInitData({ auth_date: authDate, user: JSON.stringify({ id: 100 }) }, botToken);
  const security = createApiSecurity({
    telegramBotToken: botToken,
    requireTelegramInitData: true
  });
  const req = { headers: { "x-telegram-init-data": initData } };

  assert.deepEqual(
    security.resolveVerifiedTelegramUserId(req),
    {
      telegramUserId: 100,
      verified: true,
      profile: { id: 100, firstName: null, username: null },
      startParam: null
    }
  );
});

test("verified-only API security rejects missing Telegram init data", () => {
  const security = createApiSecurity({
    telegramBotToken: "123456:test-token",
    requireTelegramInitData: false
  });

  assert.deepEqual(
    security.resolveVerifiedTelegramUserId({ headers: {} }),
    { error: "telegram_init_data_required" }
  );
});

test("account deletion endpoints require verified identity and trusted Mini App source", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const endpointPaths = [
    "/api/account-deletion/request",
    "/api/account-deletion/advance",
    "/api/account-deletion/cancel",
    "/api/account-deletion/confirm"
  ];

  for (const path of endpointPaths) {
    assert.ok(source.includes(`url.pathname === "${path}"`), `${path} route is registered`);
    const block = endpointBlock(source, path);
    assert.match(block, /apiSecurity\.resolveVerifiedTelegramUserId\(req\)/, `${path} uses verified auth`);
    assert.doesNotMatch(block, /apiSecurity\.resolveTelegramUserId\(/, `${path} does not use client-declared auth`);
    assert.match(block, /body\.source\s*!==\s*"miniapp"/, `${path} strictly rejects non-Mini App source`);
    assert.match(block, /sendJson\(res,\s*400,\s*\{\s*error:\s*"invalid_account_deletion_source"\s*\}\)/, `${path} maps invalid source to 400`);
  }
});

test("dashboard route delegates verified launches to the Mini App launch service", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const block = endpointBlock(source, "/api/dashboard");

  assert.match(source, /createMiniAppLaunchService/);
  assert.match(block, /if \(auth\.verified\)/);
  assert.match(block, /miniAppLaunchService\.loadDashboard/);
  assert.match(block, /reportType: url\.searchParams\.get\("reportType"\)/);
  assert.match(block, /reportKey: url\.searchParams\.get\("reportKey"\)/);
  assert.match(block, /timeZone/);
});

test("account deletion endpoints pass only verified Telegram identity to repository", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

  assert.match(
    endpointBlock(source, "/api/account-deletion/request"),
    /repository\.requestAccountDeletion\(auth\.telegramUserId,\s*\{\s*source:\s*"miniapp"\s*\}\)/
  );
  assert.match(
    endpointBlock(source, "/api/account-deletion/advance"),
    /repository\.advanceAccountDeletion\(auth\.telegramUserId,\s*\{\s*source:\s*"miniapp"\s*\}\)/
  );
  assert.match(
    endpointBlock(source, "/api/account-deletion/cancel"),
    /repository\.cancelAccountDeletion\(auth\.telegramUserId,\s*\{\s*source:\s*"miniapp"\s*\}\)/
  );
  const confirmBlock = endpointBlock(source, "/api/account-deletion/confirm");
  assert.match(confirmBlock, /repository\.confirmAccountDeletion\(\{\s*telegramUserId:\s*auth\.telegramUserId,\s*source:\s*"miniapp",\s*confirmationText:\s*body\.confirmationText\s*\}\)/);
  assert.doesNotMatch(confirmBlock, /\bbody\.(telegramUserId|userId|telegram_user_id|user_id)\b/);
  assert.doesNotMatch(confirmBlock, /\burl\.searchParams\.get\("(telegramUserId|userId|telegram_user_id|user_id)"\)/);
});

test("account deletion request and advance map null repository results to controlled errors", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

  assert.match(
    endpointBlock(source, "/api/account-deletion/request"),
    /if\s*\(!result\)\s*return sendJson\(res,\s*404,\s*\{\s*error:\s*"user_not_found"\s*\}\)/
  );
  assert.match(
    endpointBlock(source, "/api/account-deletion/advance"),
    /if\s*\(!result\)\s*return sendJson\(res,\s*409,\s*\{\s*error:\s*"account_deletion_not_pending"\s*\}\)/
  );
  assert.match(source, /error\.code === "account_deletion_expired"[\s\S]*return 410/);
});

test("planned expense mutation routes keep PATCH and DELETE response contracts explicit", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const routeStart = source.indexOf("const plannedMatch = url.pathname.match");
  const patchStart = source.indexOf('if (req.method === "PATCH") {', routeStart);
  const reserveHandler = source.indexOf('error.code === "reserve_conflicts_with_planned_change"', patchStart);
  const deleteStart = source.indexOf("const result = await repository.deactivatePlannedExpense", patchStart);
  const blockEnd = source.indexOf('if (req.method === "PATCH" && url.pathname === "/api/settings/budget")', deleteStart);

  assert.notEqual(routeStart, -1, "planned expense item route is registered");
  assert.notEqual(patchStart, -1, "planned expense PATCH branch is explicit");
  assert.notEqual(reserveHandler, -1, "PATCH reserve conflict handler is registered");
  assert.notEqual(deleteStart, -1, "planned expense DELETE branch is explicit");
  assert.notEqual(blockEnd, -1, "planned expense item route has a bounded source block");
  assert.ok(routeStart < patchStart, "PATCH branch follows the item route matcher");
  assert.ok(patchStart < reserveHandler, "reserve conflicts are handled inside PATCH");
  assert.ok(reserveHandler < deleteStart, "DELETE starts after PATCH reserve handling");
  assert.ok(deleteStart < blockEnd, "DELETE remains inside the planned expense item route");

  const routePrelude = source.slice(routeStart, patchStart);
  const patchBlock = source.slice(patchStart, deleteStart);
  const deleteBlock = source.slice(deleteStart, blockEnd);

  assert.match(routePrelude, /if \(plannedMatch && \(req\.method === "PATCH" \|\| req\.method === "DELETE"\)\) \{/);
  assert.match(routePrelude, /const body = await readJson\(req\);/);
  assert.match(routePrelude, /const auth = apiSecurity\.resolveTelegramUserId\(req, url, body\);/);
  assert.match(routePrelude, /if \(auth\.error\) return sendJson\(res, 400, \{ error: auth\.error \}\);/);

  assert.match(patchBlock, /const plannedExpense = await repository\.updatePlannedExpense\([\s\S]*body\.plannedExpense\s*\);/);
  assert.match(patchBlock, /if \(!plannedExpense\) return sendJson\(res, 404, \{ error: "planned_expense_not_found" \}\);/);
  assert.match(patchBlock, /return sendJson\(res, 200, \{ plannedExpense \}\);/);
  assert.match(patchBlock, /error\.code === "reserve_conflicts_with_planned_change"/);
  assert.doesNotMatch(patchBlock, /deactivatePlannedExpense/);

  assert.match(deleteBlock, /const result = await repository\.deactivatePlannedExpense\(/);
  assert.match(deleteBlock, /if \(!result\) return sendJson\(res, 404, \{ error: "planned_expense_not_found" \}\);/);
  assert.match(deleteBlock, /return sendJson\(res, 200, result\);/);
  assert.doesNotMatch(deleteBlock, /sendJson\(res,\s*200,\s*\{\s*plannedExpense\b/);
  assert.doesNotMatch(deleteBlock, /reserve_conflicts_with_planned_change/);
});

test("API security rejects invalid Telegram init data hash", () => {
  const botToken = "123456:test-token";
  const authDate = String(Math.floor(Date.now() / 1000));
  const initData = signInitData({ auth_date: authDate, user: JSON.stringify({ id: 100 }) }, botToken);
  const security = createApiSecurity({
    telegramBotToken: botToken,
    requireTelegramInitData: true
  });
  const req = { headers: { "x-telegram-init-data": initData.replace("100", "101") } };

  assert.deepEqual(
    security.resolveTelegramUserId(req, new URL("http://localhost/api/dashboard?telegramUserId=100")),
    { error: "invalid_hash" }
  );
});

test("API security rejects Telegram init data user mismatch", () => {
  const botToken = "123456:test-token";
  const authDate = String(Math.floor(Date.now() / 1000));
  const initData = signInitData({ auth_date: authDate, user: JSON.stringify({ id: 100 }) }, botToken);
  const security = createApiSecurity({
    telegramBotToken: botToken,
    requireTelegramInitData: true
  });
  const req = { headers: { "x-telegram-init-data": initData } };

  assert.deepEqual(
    security.resolveTelegramUserId(req, new URL("http://localhost/api/dashboard?telegramUserId=101")),
    { error: "telegram_user_mismatch" }
  );
});

test("API security rejects missing Telegram init data when strict auth is enabled", () => {
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

test("API security allows missing Telegram init data only when strict auth is disabled", () => {
  const security = createApiSecurity({
    telegramBotToken: "123456:test-token",
    requireTelegramInitData: false
  });
  const req = { headers: {} };
  const url = new URL("http://localhost/api/dashboard?telegramUserId=100001");

  assert.deepEqual(security.resolveTelegramUserId(req, url), { telegramUserId: 100001 });
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

test("production runtime config requires Telegram webhook secret", () => {
  const productionConfig = buildConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://localhost/money_flow",
    TELEGRAM_BOT_TOKEN: "123456:test-token",
    REQUIRE_TELEGRAM_INIT_DATA: "true"
  });

  assert.throws(
    () => requireRuntimeConfig(productionConfig),
    /TELEGRAM_WEBHOOK_SECRET is required in production/
  );
});

test("production runtime config requires strict Telegram init data auth", () => {
  const productionConfig = buildConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://localhost/money_flow",
    TELEGRAM_BOT_TOKEN: "123456:test-token",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    REQUIRE_TELEGRAM_INIT_DATA: "false"
  });

  assert.throws(
    () => requireRuntimeConfig(productionConfig),
    /REQUIRE_TELEGRAM_INIT_DATA=true is required in production/
  );
});

test("production shadow without rollout allows missing parser text hash secret", () => {
  const productionConfig = buildConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://localhost/money_flow",
    TELEGRAM_BOT_TOKEN: "123456:test-token",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    REQUIRE_TELEGRAM_INIT_DATA: "true",
    EXPENSE_FAST_PATH_MODE: "shadow"
  });

  assert.doesNotThrow(() => requireRuntimeConfig(productionConfig));
});

test("production enabled rollout requires parser text hash secret", () => {
  const productionConfig = buildConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://localhost/money_flow",
    TELEGRAM_BOT_TOKEN: "123456:test-token",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    REQUIRE_TELEGRAM_INIT_DATA: "true",
    EXPENSE_FAST_PATH_MODE: "enabled"
  });

  assert.throws(
    () => requireRuntimeConfig(productionConfig),
    /PARSER_TEXT_HASH_SECRET is required/
  );
});

test("production rollout percent and allowlist require parser text hash secret", () => {
  for (const env of [
    { EXPENSE_PARSER_LOCAL_FIRST_ROLLOUT_PERCENT: "1" },
    { EXPENSE_PARSER_LOCAL_FIRST_USER_IDS: "100001" }
  ]) {
    const productionConfig = buildConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://localhost/money_flow",
      TELEGRAM_BOT_TOKEN: "123456:test-token",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      REQUIRE_TELEGRAM_INIT_DATA: "true",
      EXPENSE_FAST_PATH_MODE: "off",
      ...env
    });

    assert.throws(
      () => requireRuntimeConfig(productionConfig),
      /PARSER_TEXT_HASH_SECRET is required/
    );
  }
});

test("test runtime config uses deterministic parser text hash secret", () => {
  const testConfig = buildConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost/money_flow"
  });

  assert.equal(testConfig.parserTextHashSecret, "test-parser-text-hash-secret");
  assert.doesNotThrow(() => requireRuntimeConfig(testConfig));
});

test("parser rollout config defaults to safe local amount and no rollout", () => {
  const localConfig = buildConfig({
    NODE_ENV: "development",
    DATABASE_URL: "postgres://localhost/money_flow"
  });

  assert.equal(localConfig.expenseParserMaxLocalAmount, 1_000_000);
  assert.equal(localConfig.expenseParserLocalFirstRolloutPercent, 0);
  assert.deepEqual(localConfig.expenseParserLocalFirstUserIds, []);
});

test("non-production runtime config keeps local direct telegram user sandbox available", () => {
  const localConfig = buildConfig({
    NODE_ENV: "development",
    DATABASE_URL: "postgres://localhost/money_flow"
  });

  assert.equal(localConfig.requireTelegramInitData, false);
  assert.doesNotThrow(() => requireRuntimeConfig(localConfig));
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

function endpointBlock(source, path) {
  const marker = `url.pathname === "${path}"`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${path} route is registered`);
  const blockStart = source.lastIndexOf("if (", start);
  const nextBlock = source.indexOf("\n  if (", start + marker.length);
  return source.slice(blockStart, nextBlock === -1 ? source.length : nextBlock);
}
