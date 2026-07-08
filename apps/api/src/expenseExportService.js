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
const DEFAULT_COOLDOWN_MS = 2 * 60_000;

export function createExpenseExportService({
  repository,
  sendDocument,
  now = () => new Date(),
  cooldownMs = DEFAULT_COOLDOWN_MS,
  pageSize = DEFAULT_PAGE_SIZE
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
        const page = await repository.listExpenseExportRowsForTelegramUser(telegramUserId, {
          period: normalizedPeriod,
          limit: pageSize,
          offset,
          now: currentTime
        });
        if (!page.length) break;
        rows.push(...page);
        offset += page.length;
        if (page.length < pageSize) break;
      }

      if (!rows.length) {
        return { status: "empty", message: exportText(language, "empty") };
      }

      const csv = writeCsv(rows.map(exportRow), EXPORT_HEADERS);
      const filename = exportFilename(normalizedPeriod, currentTime);
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

function exportRow(row) {
  return {
    date: dateOnly(row.spent_at),
    amount: stableNumber(row.amount_original),
    currency: row.currency_original ?? "",
    amount_display: stableNumber(row.display?.amount),
    display_currency: row.display?.currency ?? "",
    category: row.category_slug ?? "",
    note: row.description ?? "",
    type: "expense",
    created_at: dateTime(row.created_at)
  };
}

function exportFilename(period, date) {
  if (period === "all") return "money-flow-export-all.csv";
  return `money-flow-export-${date.toISOString().slice(0, 7)}.csv`;
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
  return (language === "ru" ? ru : en)[key];
}

function dateOnly(value) {
  return toDate(value).toISOString().slice(0, 10);
}

function dateTime(value) {
  return toDate(value).toISOString().slice(0, 19).replace("T", " ");
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
