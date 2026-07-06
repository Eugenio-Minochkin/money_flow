import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildConfig,
  parseReleaseDigestCheckIntervalMinutes,
  parseReleaseDigestSendHour
} from "../src/config.js";

test("release digest send hour accepts only integers from 0 through 23", () => {
  assert.equal(parseReleaseDigestSendHour("0"), 0);
  assert.equal(parseReleaseDigestSendHour("23"), 23);
  assert.equal(parseReleaseDigestSendHour("12.5"), 21);
  assert.equal(parseReleaseDigestSendHour("-1"), 21);
  assert.equal(parseReleaseDigestSendHour("24"), 21);
  assert.equal(parseReleaseDigestSendHour("not-a-number"), 21);
  assert.equal(parseReleaseDigestSendHour(undefined), 21);
});

test("release digest check interval accepts only positive finite numbers", () => {
  assert.equal(parseReleaseDigestCheckIntervalMinutes("0.5"), 0.5);
  assert.equal(parseReleaseDigestCheckIntervalMinutes("30"), 30);
  assert.equal(parseReleaseDigestCheckIntervalMinutes("0"), 15);
  assert.equal(parseReleaseDigestCheckIntervalMinutes("-1"), 15);
  assert.equal(parseReleaseDigestCheckIntervalMinutes("Infinity"), 15);
  assert.equal(parseReleaseDigestCheckIntervalMinutes("not-a-number"), 15);
  assert.equal(parseReleaseDigestCheckIntervalMinutes(undefined), 15);
});

test("rate limiter config accepts explicit safe values", () => {
  const config = buildConfig({
    RATE_LIMIT_WINDOW_MS: "30000",
    RATE_LIMIT_MAX_REQUESTS: "25",
    RATE_LIMIT_BUCKET_TTL_MS: "90000",
    RATE_LIMIT_CLEANUP_INTERVAL_MS: "15000",
    TRUSTED_PROXY_IPS: "127.0.0.1, ::1"
  });

  assert.equal(config.rateLimitWindowMs, 30000);
  assert.equal(config.rateLimitMax, 25);
  assert.equal(config.rateLimitBucketTtlMs, 90000);
  assert.equal(config.rateLimitCleanupIntervalMs, 15000);
  assert.deepEqual(config.trustedProxyIps, ["127.0.0.1", "::1"]);
});

test("rate limiter config falls back from invalid values", () => {
  const config = buildConfig({
    RATE_LIMIT_WINDOW_MS: "0",
    RATE_LIMIT_MAX_REQUESTS: "not-a-number",
    RATE_LIMIT_BUCKET_TTL_MS: "-1",
    RATE_LIMIT_CLEANUP_INTERVAL_MS: "Infinity",
    TRUSTED_PROXY_IPS: " , "
  });

  assert.equal(config.rateLimitWindowMs, 60000);
  assert.equal(config.rateLimitMax, 120);
  assert.equal(config.rateLimitBucketTtlMs, 120000);
  assert.equal(config.rateLimitCleanupIntervalMs, 60000);
  assert.deepEqual(config.trustedProxyIps, ["127.0.0.1", "::1"]);
});

test("server wires the release digest scheduler with Telegram token gating", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

  assert.match(source, /import \{ createReleaseDigestScheduler \} from "\.\/releaseDigestScheduler\.js";/);
  assert.match(
    source,
    /enabled:\s*config\.releaseDigestAutoSendEnabled\s*&&\s*Boolean\(config\.telegramBotToken\)/
  );
  assert.match(source, /releaseDigestScheduler\.start\(\)/);
  assert.match(source, /\[release-digest\] scheduler failed/);
});
