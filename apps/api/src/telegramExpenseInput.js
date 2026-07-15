import { SUPPORTED_CURRENCY_CODES } from "../../../packages/shared/src/currencies.js";
import { localDateTimeToUtc } from "../../../packages/shared/src/time.js";

const MAX_AMOUNT = 1_000_000;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 64;

const RU_MONTHS = new Map([
  ["января", 1], ["январь", 1], ["февраля", 2], ["февраль", 2], ["марта", 3], ["март", 3],
  ["апреля", 4], ["апрель", 4], ["мая", 5], ["май", 5], ["июня", 6], ["июнь", 6],
  ["июля", 7], ["июль", 7], ["августа", 8], ["август", 8], ["сентября", 9], ["сентябрь", 9],
  ["октября", 10], ["октябрь", 10], ["ноября", 11], ["ноябрь", 11], ["декабря", 12], ["декабрь", 12]
]);

const EN_MONTHS = new Map([
  ["january", 1], ["jan", 1], ["february", 2], ["feb", 2], ["march", 3], ["mar", 3],
  ["april", 4], ["apr", 4], ["may", 5], ["june", 6], ["jun", 6], ["july", 7], ["jul", 7],
  ["august", 8], ["aug", 8], ["september", 9], ["sep", 9], ["sept", 9], ["october", 10], ["oct", 10],
  ["november", 11], ["nov", 11], ["december", 12], ["dec", 12]
]);

export function parseAmountInput(text, { currentCurrency = "THB" } = {}) {
  const match = /^(\d+(?:[.,]\d{1,2})?)\s*([a-z]{3})?$/iu.exec(String(text ?? "").trim());
  if (!match) throw codedError("expense_invalid_amount");

  const amount = Number(match[1].replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    throw codedError("expense_invalid_amount");
  }

  const currency = String(match[2] ?? currentCurrency).toUpperCase();
  if (!SUPPORTED_CURRENCY_CODES.includes(currency)) throw codedError("expense_invalid_currency");
  return { amount, currency };
}

export function parseDescriptionInput(text) {
  const description = String(text ?? "").trim();
  if (!description || description.length > MAX_DESCRIPTION_LENGTH) {
    throw codedError("expense_invalid_description");
  }
  return description;
}

export function parseTagsInput(text) {
  const source = String(text ?? "").trim();
  if (source === "-") return [];

  const unique = [];
  const seen = new Set();
  for (const rawTag of source.split(",")) {
    const tag = rawTag.trim();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) throw codedError("expense_invalid_tags");
    const key = tag.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(tag);
    }
  }
  if (!unique.length || unique.length > MAX_TAGS) throw codedError("expense_invalid_tags");
  return unique;
}

export function parseSpentAtInput(text, { now = new Date(), timeZone, language } = {}) {
  const source = String(text ?? "").trim().replace(/\s+/g, " ");
  const timeMatch = /(?:\s|,)(\d{1,2}):(\d{2})$/u.exec(source);
  if (!timeMatch) throw codedError("expense_invalid_date");

  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (hour > 23 || minute > 59) throw codedError("expense_invalid_date");

  const dateText = source.slice(0, timeMatch.index).trim().replace(/,$/u, "");
  const nowParts = localParts(now, timeZone);
  const date = parseDateText(dateText, nowParts, language);
  if (!date) throw codedError("expense_invalid_date");

  let spentAt;
  try {
    spentAt = localDateTimeToUtc({ ...date, hour, minute }, timeZone);
  } catch {
    throw codedError("expense_invalid_date");
  }
  if (spentAt > now) throw codedError("expense_future_date");
  return spentAt;
}

export function parseEditorText(field, text, context = {}) {
  if (field === "amount") return parseAmountInput(text, context);
  if (field === "description") return parseDescriptionInput(text);
  if (field === "tags") return parseTagsInput(text);
  if (field === "spent_at") return parseSpentAtInput(text, context);
  throw codedError("expense_invalid_field");
}

function parseDateText(text, nowParts, language) {
  const normalized = String(text).trim().toLocaleLowerCase();
  if (normalized === "сегодня" || normalized === "today") return pickYearlessDate(nowParts.year, nowParts.month, nowParts.day, nowParts);
  if (normalized === "вчера" || normalized === "yesterday") {
    const yesterday = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day - 1));
    return { year: yesterday.getUTCFullYear(), month: yesterday.getUTCMonth() + 1, day: yesterday.getUTCDate() };
  }

  const months = language === "ru" ? RU_MONTHS : EN_MONTHS;
  let match = /^(\d{1,2})\s+([^\s]+)(?:\s+(\d{4}))?$/u.exec(normalized);
  if (match && months.has(match[2])) {
    return resolveCalendarDate(Number(match[1]), months.get(match[2]), match[3], nowParts);
  }

  match = /^([^\s]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/u.exec(normalized);
  if (match && months.has(match[1])) {
    return resolveCalendarDate(Number(match[2]), months.get(match[1]), match[3], nowParts);
  }
  return null;
}

function resolveCalendarDate(day, month, explicitYear, nowParts) {
  if (explicitYear) return { year: Number(explicitYear), month, day };
  return pickYearlessDate(nowParts.year, month, day, nowParts);
}

function pickYearlessDate(startYear, month, day, nowParts) {
  let year = startYear;
  if (month > nowParts.month || (month === nowParts.month && day > nowParts.day)) year -= 1;
  while (year >= startYear - 8 && daysInMonth(year, month) < day) year -= 1;
  return year < startYear - 8 ? null : { year, month, day };
}

function localParts(date, timeZone) {
  const values = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return { year: values.year, month: values.month, day: values.day };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
