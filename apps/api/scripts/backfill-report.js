import { config, requireRuntimeConfig } from "../src/config.js";
import { closeDb, migrate, pool } from "../src/db.js";
import { createExchangeRateProvider } from "../src/exchangeRates.js";
import { createRepository } from "../src/repository.js";
import { createReportService } from "../src/reportService.js";
import { sendTelegramMessage } from "../src/telegram.js";

requireRuntimeConfig();

const args = parseArgs(process.argv.slice(2));
if (!args.periodKey) {
  console.error("Usage: npm run reports:backfill -- --period YYYY-MM [--send] [--force]");
  process.exitCode = 1;
} else {
  await migrate();
  const repository = createRepository(pool, {
    defaultMonthlyBudget: config.defaultMonthlyBudget,
    exchangeRates: createExchangeRateProvider()
  });
  const service = createReportService({
    repository,
    miniAppUrl: config.miniAppUrl,
    sendMessage: (message) => sendTelegramMessage({
      token: config.telegramBotToken,
      ...message
    })
  });
  const summary = await service.backfillMonthlyReport(args.periodKey, {
    dryRun: !args.send,
    force: args.force
  });
  console.log(JSON.stringify({
    reportType: "monthly",
    periodKey: args.periodKey,
    dryRun: !args.send,
    force: args.force,
    ...summary
  }, null, 2));
  await closeDb();
}

function parseArgs(argv) {
  const result = { periodKey: null, send: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--period") {
      result.periodKey = normalizePeriod(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith("--period=")) {
      result.periodKey = normalizePeriod(arg.slice("--period=".length));
    } else if (arg === "--send") {
      result.send = true;
    } else if (arg === "--force") {
      result.force = true;
    }
  }
  return result;
}

function normalizePeriod(value) {
  const period = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}$/.test(period)) {
    throw new Error("Monthly report backfill period must use YYYY-MM");
  }
  return period;
}
