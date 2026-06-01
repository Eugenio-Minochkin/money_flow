export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  miniAppUrl: process.env.MINI_APP_URL ?? "http://localhost:3000",
  defaultMonthlyBudget: Number(process.env.DEFAULT_MONTHLY_BUDGET ?? 45000)
};

export function requireRuntimeConfig() {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
}
