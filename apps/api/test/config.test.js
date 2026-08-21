import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildConfig,
  parseReleaseDigestCheckIntervalMinutes,
  parseReleaseDigestSendHour,
  requireRuntimeConfig
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
  assert.deepEqual(config.trustedProxyIps, ["127.0.0.1", "::1", "172.18.0.1"]);
});

test("admin alert config parses explicit safe values", () => {
  const config = buildConfig({
    ADMIN_ALERTS_ENABLED: "true",
    ADMIN_ALERT_THROTTLE_MS: "300000",
    ADMIN_ALERT_MAX_MESSAGE_LENGTH: "700"
  });

  assert.equal(config.adminAlertsEnabled, true);
  assert.equal(config.adminAlertThrottleMs, 300000);
  assert.equal(config.adminAlertMaxMessageLength, 700);
});

test("admin alert config defaults and rejects invalid values", () => {
  const config = buildConfig({
    ADMIN_ALERT_THROTTLE_MS: "0",
    ADMIN_ALERT_MAX_MESSAGE_LENGTH: "not-a-number"
  });

  assert.equal(config.adminAlertsEnabled, false);
  assert.equal(config.adminAlertThrottleMs, 600000);
  assert.equal(config.adminAlertMaxMessageLength, 900);
});

test("daily reminders default on in production while preserving an explicit kill switch", () => {
  assert.equal(buildConfig({ NODE_ENV: "production" }).dailyReminderGlobalEnabled, true);
  assert.equal(
    buildConfig({ NODE_ENV: "production", DAILY_REMINDER_GLOBAL_ENABLED: "false" }).dailyReminderGlobalEnabled,
    false
  );
  assert.equal(buildConfig({ NODE_ENV: "development" }).dailyReminderGlobalEnabled, false);
  assert.equal(
    buildConfig({ NODE_ENV: "development", DAILY_REMINDER_GLOBAL_ENABLED: "true" }).dailyReminderGlobalEnabled,
    true
  );
});

test("planned payment reminders default on only in production and use a validated send hour", () => {
  assert.equal(buildConfig({ NODE_ENV: "production" }).plannedPaymentReminderGlobalEnabled, true);
  assert.equal(buildConfig({ NODE_ENV: "development" }).plannedPaymentReminderGlobalEnabled, false);
  assert.equal(buildConfig({
    NODE_ENV: "production",
    PLANNED_PAYMENT_REMINDER_GLOBAL_ENABLED: "false"
  }).plannedPaymentReminderGlobalEnabled, false);
  assert.equal(buildConfig({ PLANNED_PAYMENT_REMINDER_SEND_HOUR: "18" }).plannedPaymentReminderSendHour, 18);
  assert.equal(buildConfig({ PLANNED_PAYMENT_REMINDER_SEND_HOUR: "24" }).plannedPaymentReminderSendHour, 21);
});

test("server wires planned reminder scheduler with admin alert containment", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

  assert.match(source, /createPlannedPaymentReminderService/);
  assert.match(source, /plannedPaymentReminderService\.runOnce\(\)/);
  assert.match(source, /jobName:\s*"planned-payment-reminder"/);
  assert.match(source, /plannedPaymentReminderGlobalEnabled/);
});

test("expense parser LLM timeout defaults only when absent and fails fast on explicit invalid values", () => {
  assert.equal(buildConfig({}).expenseParserLlmTimeoutMs, 20000);
  assert.equal(buildConfig({ EXPENSE_PARSER_LLM_TIMEOUT_MS: "15000" }).expenseParserLlmTimeoutMs, 15000);

  for (const value of ["", "0", "-1", "1.5", "1e3", "Infinity", "not-a-number", "2147483648"]) {
    assert.throws(
      () => buildConfig({ EXPENSE_PARSER_LLM_TIMEOUT_MS: value }),
      /Invalid configuration: EXPENSE_PARSER_LLM_TIMEOUT_MS must be a positive integer from 1 to 2147483647 milliseconds/,
      value
    );
  }
});

test("paid AI guard defaults are generous and each provider has an independent kill switch", () => {
  const config = buildConfig({});
  assert.equal(config.paidAiWindowMs, 86_400_000);
  assert.equal(config.openAiParserUserLimit, 100);
  assert.equal(config.deepgramTranscriptionUserLimit, 50);
  assert.equal(config.deepgramMaxAudioDurationSec, 60);
  assert.equal(config.deepgramMaxAudioWindowSec, 900);
  assert.equal(config.openAiParserGlobalEnabled, true);
  assert.equal(config.deepgramTranscriptionGlobalEnabled, true);

  const disabled = buildConfig({ OPENAI_PARSER_GLOBAL_ENABLED: "false", DEEPGRAM_TRANSCRIPTION_GLOBAL_ENABLED: "false" });
  assert.equal(disabled.openAiParserGlobalEnabled, false);
  assert.equal(disabled.deepgramTranscriptionGlobalEnabled, false);
});

test("expense evidence import is disabled by default and validates bounded runtime settings", () => {
  const defaults = buildConfig({});
  assert.equal(defaults.expenseEvidenceImportEnabled, false);
  assert.equal(defaults.expenseEvidenceMaxBytes, 10_485_760);
  assert.equal(defaults.expenseEvidenceTimeoutMs, 30_000);
  assert.equal(defaults.expenseEvidenceModel, "gpt-5-mini");

  const configured = buildConfig({
    OPENAI_MODEL: "gpt-5.4-mini",
    EXPENSE_EVIDENCE_IMPORT_ENABLED: "true",
    EXPENSE_EVIDENCE_MAX_BYTES: "5242880",
    EXPENSE_EVIDENCE_TIMEOUT_MS: "15000",
    EXPENSE_EVIDENCE_MODEL: "gpt-5.4",
    EXPENSE_EVIDENCE_HMAC_SECRET: "test-evidence-secret"
  });
  assert.equal(configured.expenseEvidenceImportEnabled, true);
  assert.equal(configured.expenseEvidenceMaxBytes, 5_242_880);
  assert.equal(configured.expenseEvidenceTimeoutMs, 15_000);
  assert.equal(configured.expenseEvidenceModel, "gpt-5.4");
  assert.equal(configured.expenseEvidenceHmacSecret, "test-evidence-secret");

  for (const name of ["EXPENSE_EVIDENCE_MAX_BYTES", "EXPENSE_EVIDENCE_TIMEOUT_MS"]) {
    assert.throws(
      () => buildConfig({ [name]: "0" }),
      new RegExp(`Invalid configuration: ${name}`)
    );
  }
});

test("production evidence import requires its dedicated HMAC secret only when enabled", () => {
  const common = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://localhost/money_flow",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    REQUIRE_TELEGRAM_INIT_DATA: "true"
  };

  assert.doesNotThrow(() => requireRuntimeConfig(buildConfig(common)));
  assert.throws(
    () => requireRuntimeConfig(buildConfig({ ...common, EXPENSE_EVIDENCE_IMPORT_ENABLED: "true" })),
    /EXPENSE_EVIDENCE_HMAC_SECRET is required in production when expense evidence import is enabled/
  );
  assert.doesNotThrow(() => requireRuntimeConfig(buildConfig({
    ...common,
    EXPENSE_EVIDENCE_IMPORT_ENABLED: "true",
    EXPENSE_EVIDENCE_HMAC_SECRET: "evidence-secret"
  })));
});

test("server wires expense parser LLM timeout", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

  assert.match(source, /llmTimeoutMs:\s*config\.expenseParserLlmTimeoutMs/);
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

test("server wires admin alerts into runtime error paths", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

  assert.match(source, /import \{ createAdminAlertService \} from "\.\/adminAlerts\.js";/);
  assert.match(source, /const adminAlertService = createAdminAlertService\(/);
  assert.match(source, /enabled:\s*config\.adminAlertsEnabled\s*&&\s*Boolean\(config\.telegramBotToken\)/);
  assert.match(source, /adminTelegramIds/);
  assert.match(source, /throttleMs:\s*config\.adminAlertThrottleMs/);
  assert.match(source, /maxMessageLength:\s*config\.adminAlertMaxMessageLength/);
  assert.match(source, /safeNotifyAdminError\(adminAlertService,\s*error,\s*\{\s*source:\s*"api"/);
  assert.match(source, /if\s*\(error\?\.adminAlertSent\)\s*return/);
  assert.match(source, /\.catch\(\(alertError\)\s*=>/);
  assert.match(source, /adminAlertService/);
});

test("server wires expense export through verified Mini App auth and shared service", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

  assert.match(source, /import \{ createExpenseExportService \} from "\.\/expenseExportService\.js";/);
  assert.match(source, /sendTelegramDocument/);
  assert.match(source, /const expenseExportService = createExpenseExportService\(/);
  assert.match(source, /url\.pathname === "\/api\/exports\/expenses"/);
  assert.match(source, /apiSecurity\.resolveVerifiedTelegramUserId\(req\)/);
  assert.match(source, /expenseExportService\.requestExport\(/);
});
