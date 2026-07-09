import { DEFAULT_TIMEZONE, localDateKey, localMonthKey, normalizeTimeZone } from "../../../packages/shared/src/time.js";
import { writeCsv } from "./csvWriter.js";

const EXPORT_HEADERS = [
  "date",
  "amount",
  "currency",
  "amount_display",
  "display_currency",
  "category",
  "note",
  "type",
  "created_at"
];

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_MAX_EXPORT_ROWS = 10000;
const DEFAULT_COOLDOWN_MS = 2 * 60_000;

export function createExpenseExportService({
  repository,
  sendDocument,
  now = () => new Date(),
  cooldownMs = DEFAULT_COOLDOWN_MS,
  pageSize = DEFAULT_PAGE_SIZE,
  maxRows = DEFAULT_MAX_EXPORT_ROWS
}) {
  const lastExportByUser = new Map();

  return {
    async requestExport({ telegramUserId, chatId, period = "month", language = "en" }) {
      const normalizedPeriod = period === "all" ? "all" : "month";
      const currentTime = now();
      const lastExportAt = lastExportByUser.get(telegramUserId);
      if (lastExportAt && currentTime.getTime() - lastExportAt.getTime() < cooldownMs) {
        return { status: "throttled", message: exportText(language, "throttled") };
      }
      lastExportByUser.set(telegramUserId, currentTime);

      const rows = [];
      let offset = 0;
      while (true) {
        const limit = Math.min(pageSize, maxRows + 1 - rows.length);
        const page = await repository.listExpenseExportRowsForTelegramUser(telegramUserId, {
          period: normalizedPeriod,
          limit,
          offset,
          now: currentTime
        });
        if (!page.length) break;
        rows.push(...page);
        if (rows.length > maxRows) {
          return { status: "too_large", message: exportText(language, "tooLarge") };
        }
        offset += page.length;
        if (page.length < limit) break;
      }

      if (!rows.length) {
        return { status: "empty", message: exportText(language, "empty") };
      }

      const timeZone = rowTimeZone(rows[0]);
      const csv = writeCsv(rows.map((row) => exportRow(row, timeZone)), EXPORT_HEADERS);
      const filename = exportFilename(normalizedPeriod, currentTime, timeZone);
      await sendDocument({
        chatId,
        filename,
        content: Buffer.from(csv, "utf8"),
        contentType: "text/csv; charset=utf-8",
        caption: exportText(language, "caption")
      });
      return { status: "sent", message: exportText(language, "sent"), filename };
    }
  };
}

function exportRow(row, timeZone) {
  return {
    date: dateOnly(row.spent_at, timeZone),
    amount: stableNumber(row.amount_original),
    currency: row.currency_original ?? "",
    amount_display: stableNumber(row.display?.amount),
    display_currency: row.display?.currency ?? "",
    category: row.category_slug ?? "",
    note: row.description ?? "",
    type: "expense",
    created_at: dateTime(row.created_at, timeZone)
  };
}

function exportFilename(period, date, timeZone) {
  if (period === "all") return "money-flow-export-all.csv";
  return `money-flow-export-${localMonthKey(date, timeZone)}.csv`;
}

function exportText(language, key) {
  const ru = {
    empty: "За выбранный период расходов нет.",
    throttled: "Экспорт уже запущен или недавно запрашивался. Попробуйте позже.",
    caption: "Готово, вот ваш CSV-файл.",
    sent: "Готово, вот ваш CSV-файл."
  };
  const en = {
    empty: "No expenses for the selected period.",
    throttled: "Export is already running or was just requested. Please try again later.",
    caption: "Done, here is your CSV file.",
    sent: "Done, here is your CSV file."
  };
  if (key === "tooLarge") {
    return language === "ru"
      ? "Экспорт слишком большой. Попробуйте выбрать меньший период."
      : "Export is too large. Please choose a smaller period.";
  }
  return (language === "ru" ? ru : en)[key];
}

function dateOnly(value, timeZone) {
  return localDateKey(toDate(value), timeZone);
}

function dateTime(value, timeZone) {
  const parts = localDateTimeParts(toDate(value), timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
}

function toDate(value) {
  return value instanceof Date ? value : new Date(value);
}

function stableNumber(value) {
  if (value == null || value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return String(number);
}

function rowTimeZone(row) {
  return normalizeTimeZone(row?.user_timezone ?? row?.timezone, DEFAULT_TIMEZONE).timeZone;
}

function localDateTimeParts(date, timeZone) {
  const values = {};
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return values;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}
