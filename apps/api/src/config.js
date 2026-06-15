import { parseAdminTelegramIds } from "./releaseNotesService.js";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  adminTelegramIds: parseAdminTelegramIds(process.env.ADMIN_TELEGRAM_IDS),
  miniAppUrl: process.env.MINI_APP_URL ?? "http://localhost:3000",
  defaultMonthlyBudget: Number(process.env.DEFAULT_MONTHLY_BUDGET ?? 45000),
  openAiApiKey: process.env.OPENAI_API_KEY,
  openAiModel: process.env.OPENAI_MODEL ?? "gpt-5-mini",
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
  requireTelegramInitData: process.env.REQUIRE_TELEGRAM_INIT_DATA === "true",
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 120),
  maxJsonBytes: Number(process.env.MAX_JSON_BYTES ?? 256_000)
};

export function requireRuntimeConfig() {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
}
