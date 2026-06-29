const DEFAULT_RELEASE_DIGEST_SEND_HOUR = 21;
const DEFAULT_RELEASE_DIGEST_CHECK_INTERVAL_MINUTES = 15;

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
  return {
    nodeEnv: env.NODE_ENV ?? "development",
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    adminTelegramIds: env.ADMIN_TELEGRAM_IDS ?? "",
    miniAppUrl: env.MINI_APP_URL ?? "http://localhost:3000",
    defaultMonthlyBudget: Number(env.DEFAULT_MONTHLY_BUDGET ?? 45000),
    openAiApiKey: env.OPENAI_API_KEY,
    openAiModel: env.OPENAI_MODEL ?? "gpt-5-mini",
    expenseFastPathMode: env.EXPENSE_FAST_PATH_MODE ?? "off",
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
  }
}
