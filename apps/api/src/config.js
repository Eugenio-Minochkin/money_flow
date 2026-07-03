const DEFAULT_RELEASE_DIGEST_SEND_HOUR = 21;
const DEFAULT_RELEASE_DIGEST_CHECK_INTERVAL_MINUTES = 15;
const DEFAULT_EXPENSE_PARSER_MAX_LOCAL_AMOUNT = 1_000_000;

export function parseReleaseDigestSendHour(value) {
  const parsed = Number(value ?? DEFAULT_RELEASE_DIGEST_SEND_HOUR);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23
    ? parsed
    : DEFAULT_RELEASE_DIGEST_SEND_HOUR;
}

export function parseReleaseDigestCheckIntervalMinutes(value) {
  const parsed = Number(value ?? DEFAULT_RELEASE_DIGEST_CHECK_INTERVAL_MINUTES);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RELEASE_DIGEST_CHECK_INTERVAL_MINUTES;
}

export const config = buildConfig(process.env);

export function buildConfig(env) {
  const nodeEnv = env.NODE_ENV ?? "development";
  return {
    nodeEnv,
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    adminTelegramIds: env.ADMIN_TELEGRAM_IDS ?? "",
    miniAppUrl: env.MINI_APP_URL ?? "http://localhost:3000",
    defaultMonthlyBudget: Number(env.DEFAULT_MONTHLY_BUDGET ?? 45000),
    openAiApiKey: env.OPENAI_API_KEY,
    openAiModel: env.OPENAI_MODEL ?? "gpt-5-mini",
    expenseFastPathMode: env.EXPENSE_PARSER_FAST_PATH_MODE ?? env.EXPENSE_FAST_PATH_MODE ?? "off",
    expenseParserLocalFirstRolloutPercent: parsePercent(env.EXPENSE_PARSER_LOCAL_FIRST_ROLLOUT_PERCENT),
    expenseParserLocalFirstUserIds: parseCsv(env.EXPENSE_PARSER_LOCAL_FIRST_USER_IDS),
    expenseParserMaxLocalAmount: parsePositiveNumber(
      env.EXPENSE_PARSER_MAX_LOCAL_AMOUNT,
      DEFAULT_EXPENSE_PARSER_MAX_LOCAL_AMOUNT
    ),
    parserTextHashSecret: env.PARSER_TEXT_HASH_SECRET ?? (nodeEnv === "test" ? "test-parser-text-hash-secret" : ""),
    deepgramApiKey: env.DEEPGRAM_API_KEY,
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    requireTelegramInitData: env.REQUIRE_TELEGRAM_INIT_DATA === "true",
    rateLimitWindowMs: Number(env.RATE_LIMIT_WINDOW_MS ?? 60_000),
    rateLimitMax: Number(env.RATE_LIMIT_MAX ?? 120),
    maxJsonBytes: Number(env.MAX_JSON_BYTES ?? 256_000),
    telegramJobGlobalConcurrency: Number(env.TELEGRAM_JOB_GLOBAL_CONCURRENCY ?? 3),
    telegramJobUserQueueLimit: Number(env.TELEGRAM_JOB_USER_QUEUE_LIMIT ?? 2),
    telegramJobTimeoutMs: Number(env.TELEGRAM_JOB_TIMEOUT_MS ?? 90_000),
    releaseDigestAutoSendEnabled: env.RELEASE_DIGEST_AUTO_SEND_ENABLED === "true",
    releaseDigestTimezone: env.RELEASE_DIGEST_TIMEZONE ?? "Asia/Bangkok",
    releaseDigestSendHour: parseReleaseDigestSendHour(env.RELEASE_DIGEST_SEND_HOUR),
    releaseDigestCheckIntervalMinutes: parseReleaseDigestCheckIntervalMinutes(
      env.RELEASE_DIGEST_CHECK_INTERVAL_MINUTES
    ),
    githubToken: env.GITHUB_TOKEN,
    githubRepository: env.GITHUB_REPOSITORY,
    dailyReminderGlobalEnabled: env.DAILY_REMINDER_GLOBAL_ENABLED === "true",
    dailyReminderRolloutPercent: Number(env.DAILY_REMINDER_ROLLOUT_PERCENT ?? 0),
    dailyReminderIntervalMs: Number(env.DAILY_REMINDER_INTERVAL_MS ?? 10 * 60_000)
  };
}

export function requireRuntimeConfig(runtimeConfig = config) {
  if (!runtimeConfig.databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  if (runtimeConfig.nodeEnv === "production") {
    if (!runtimeConfig.telegramWebhookSecret) {
      throw new Error("TELEGRAM_WEBHOOK_SECRET is required in production");
    }
    if (!runtimeConfig.requireTelegramInitData) {
      throw new Error("REQUIRE_TELEGRAM_INIT_DATA=true is required in production");
    }
    if (localFirstDiagnosticsEnabled(runtimeConfig) && !runtimeConfig.parserTextHashSecret) {
      throw new Error("PARSER_TEXT_HASH_SECRET is required in production when parser diagnostics or rollout are enabled");
    }
  }
}

function parsePercent(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function parsePositiveNumber(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function parseCsv(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function localFirstDiagnosticsEnabled(runtimeConfig) {
  return runtimeConfig.expenseFastPathMode === "shadow"
    || runtimeConfig.expenseFastPathMode === "enabled"
    || Number(runtimeConfig.expenseParserLocalFirstRolloutPercent) > 0
    || runtimeConfig.expenseParserLocalFirstUserIds.length > 0;
}
