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

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  adminTelegramIds: process.env.ADMIN_TELEGRAM_IDS ?? "",
  miniAppUrl: process.env.MINI_APP_URL ?? "http://localhost:3000",
  defaultMonthlyBudget: Number(process.env.DEFAULT_MONTHLY_BUDGET ?? 45000),
  openAiApiKey: process.env.OPENAI_API_KEY,
  openAiModel: process.env.OPENAI_MODEL ?? "gpt-5-mini",
  expenseFastPathMode: process.env.EXPENSE_FAST_PATH_MODE ?? "off",
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
  requireTelegramInitData: process.env.REQUIRE_TELEGRAM_INIT_DATA === "true",
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 120),
  maxJsonBytes: Number(process.env.MAX_JSON_BYTES ?? 256_000),
  telegramJobGlobalConcurrency: Number(process.env.TELEGRAM_JOB_GLOBAL_CONCURRENCY ?? 3),
  telegramJobUserQueueLimit: Number(process.env.TELEGRAM_JOB_USER_QUEUE_LIMIT ?? 2),
  telegramJobTimeoutMs: Number(process.env.TELEGRAM_JOB_TIMEOUT_MS ?? 90_000),
  releaseDigestAutoSendEnabled: process.env.RELEASE_DIGEST_AUTO_SEND_ENABLED === "true",
  releaseDigestTimezone: process.env.RELEASE_DIGEST_TIMEZONE ?? "Asia/Bangkok",
  releaseDigestSendHour: parseReleaseDigestSendHour(process.env.RELEASE_DIGEST_SEND_HOUR),
  releaseDigestCheckIntervalMinutes: parseReleaseDigestCheckIntervalMinutes(
    process.env.RELEASE_DIGEST_CHECK_INTERVAL_MINUTES
  ),
  githubToken: process.env.GITHUB_TOKEN,
  githubRepository: process.env.GITHUB_REPOSITORY,
  dailyReminderGlobalEnabled: process.env.DAILY_REMINDER_GLOBAL_ENABLED === "true",
  dailyReminderRolloutPercent: Number(process.env.DAILY_REMINDER_ROLLOUT_PERCENT ?? 0),
  dailyReminderIntervalMs: Number(process.env.DAILY_REMINDER_INTERVAL_MS ?? 10 * 60_000)
};

export function requireRuntimeConfig() {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
}
