import { parseExpenseText } from "./parser.js";

const WEEKDAYS = [
  { value: 1, names: ["monday", "mon", "понедельник", "понедельникам"] },
  { value: 2, names: ["tuesday", "tue", "вторник", "вторникам"] },
  { value: 3, names: ["wednesday", "wed", "среда", "среду", "средам"] },
  { value: 4, names: ["thursday", "thu", "четверг", "четвергам"] },
  { value: 5, names: ["friday", "fri", "пятница", "пятницу", "пятницам"] },
  { value: 6, names: ["saturday", "sat", "суббота", "субботу", "субботам"] },
  { value: 7, names: ["sunday", "sun", "воскресенье", "воскресеньям"] }
];

export function parsePlannedExpenseText(text, options = {}) {
  const source = String(text ?? "").trim();
  if (!source) return null;

  const lowered = source.toLowerCase();
  const recurrence = detectRecurrence(lowered, options.now ?? new Date());
  if (!recurrence) return null;

  const cleaned = cleanRecurrenceWords(source);
  const parsed = parseExpenseText(cleaned, {
    now: options.now,
    defaultCurrency: options.defaultCurrency
  });
  const expense = parsed.expenses[0];
  if (!expense) return null;

  return {
    amount: expense.amount,
    currency: expense.currency,
    description: cleanDescription(expense.description),
    category_slug: expense.category_slug,
    tags: [...new Set([...(expense.tags ?? []), "regular"])],
    recurrence: recurrence.type,
    due_day: recurrence.dueDay,
    due_days: recurrence.dueDays,
    weekday: recurrence.weekday,
    due_date: null
  };
}

function detectRecurrence(text, now) {
  const weekday = detectWeekday(text);
  if (weekday && /(every|кажд|по\s+)/iu.test(text)) {
    return { type: "weekly", weekday, dueDay: null, dueDays: [] };
  }

  const twoDays = text.match(/(?:два раза в месяц|twice a month|2 раза в месяц).*?(\d{1,2})\D+(\d{1,2})/iu)
    ?? text.match(/(\d{1,2})\D+(?:и|and|,)\D*(\d{1,2}).*(?:два раза в месяц|twice a month|2 раза в месяц)/iu);
  if (twoDays) {
    const dueDays = [Number(twoDays[1]), Number(twoDays[2])].filter((day) => day >= 1 && day <= 31);
    if (dueDays.length === 2) return { type: "twice_monthly", weekday: null, dueDay: dueDays[0], dueDays };
  }

  if (/(every month|monthly|кажд.*месяц|раз в месяц)/iu.test(text)) {
    const dayMatch = text.match(/(\d{1,2})\s*(?:числа|day)?/iu);
    const dueDay = normalizeDueDay(dayMatch?.[1], now);
    return { type: "monthly", weekday: null, dueDay, dueDays: [dueDay] };
  }

  return null;
}

function detectWeekday(text) {
  for (const weekday of WEEKDAYS) {
    if (weekday.names.some((name) => new RegExp(`\\b${name}\\b`, "iu").test(text))) {
      return weekday.value;
    }
  }
  return null;
}

function normalizeDueDay(value, now) {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 31) return numeric;
  const local = new Date(now.getTime() + 7 * 60 * 60_000);
  return local.getUTCDate();
}

function cleanRecurrenceWords(text) {
  return text
    .replace(/\b(every|each)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/giu, "")
    .replace(/\b(every month|monthly|twice a month)\b/giu, "")
    .replace(/\bкажд(?:ый|ую|ое|ая)?\s+(понедельник|вторник|среду|среда|четверг|пятницу|пятница|субботу|суббота|воскресенье)\b/giu, "")
    .replace(/\bпо\s+(понедельникам|вторникам|средам|четвергам|пятницам|субботам|воскресеньям)\b/giu, "")
    .replace(/\b(каждый месяц|раз в месяц|два раза в месяц|2 раза в месяц)\b/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function cleanDescription(value) {
  return String(value || "planned expense")
    .replace(/\b(числа|day)\b/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
}
