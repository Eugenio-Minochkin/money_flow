import {
  localDateRangeBounds,
  localHour,
  localMonthDay,
  localWeekday,
  normalizeTimeZone,
  timeZoneMonthBounds
} from "../../../packages/shared/src/time.js";

const SEND_START_HOUR = 9;
const SEND_END_HOUR = 14;

export function shouldSendWeeklyReportForUser(now = new Date(), timeZoneValue) {
  const timeZone = normalizeTimeZone(timeZoneValue).timeZone;
  return localWeekday(now, timeZone) === 1 && isInsideSendWindow(now, timeZone);
}

export function shouldSendMonthlyReportForUser(now = new Date(), timeZoneValue) {
  const timeZone = normalizeTimeZone(timeZoneValue).timeZone;
  return localMonthDay(now, timeZone) === 1 && isInsideSendWindow(now, timeZone);
}

export function weeklyPeriodForSend(now = new Date(), timeZoneValue) {
  const timeZone = normalizeTimeZone(timeZoneValue).timeZone;
  const parts = zonedDateParts(now, timeZone);
  const mondayThisWeek = addLocalDays(parts, -(localWeekday(now, timeZone) - 1));
  const start = addLocalDays(mondayThisWeek, -7);
  const endExclusive = mondayThisWeek;
  const endInclusive = addLocalDays(endExclusive, -1);

  return {
    reportType: "weekly",
    periodKey: isoWeekKeyForLocalDate(start.year, start.month, start.day),
    periodStartUtc: zonedTimeToUtc(start.year, start.month, start.day, 0, timeZone),
    periodEndUtc: zonedTimeToUtc(endExclusive.year, endExclusive.month, endExclusive.day, 0, timeZone),
    localStartDate: formatLocalDate(start),
    localEndDate: formatLocalDate(endInclusive),
    timezoneUsed: timeZone
  };
}

export function monthlyPeriodForSend(now = new Date(), timeZoneValue) {
  const timeZone = normalizeTimeZone(timeZoneValue).timeZone;
  const parts = zonedDateParts(now, timeZone);
  const currentMonthStart = { year: parts.year, month: parts.month, day: 1 };
  const previousMonth = parts.month === 1
    ? { year: parts.year - 1, month: 12 }
    : { year: parts.year, month: parts.month - 1 };
  const start = { ...previousMonth, day: 1 };
  const endInclusive = addLocalDays(currentMonthStart, -1);

  return {
    reportType: "monthly",
    periodKey: `${start.year}-${pad2(start.month)}`,
    periodStartUtc: zonedTimeToUtc(start.year, start.month, start.day, 0, timeZone),
    periodEndUtc: zonedTimeToUtc(currentMonthStart.year, currentMonthStart.month, currentMonthStart.day, 0, timeZone),
    localStartDate: formatLocalDate(start),
    localEndDate: formatLocalDate(endInclusive),
    timezoneUsed: timeZone
  };
}

export function priorWeeklyBounds(period, timeZoneValue) {
  const timeZone = normalizeTimeZone(timeZoneValue).timeZone;
  const reportStart = period.localStartDate ?? localWeekStartKey(period, timeZone);
  const priorMonday = shiftDayKey(reportStart, -7);
  const priorSunday = shiftDayKey(reportStart, -1);
  const bounds = localDateRangeBounds(priorMonday, priorSunday, timeZone);
  return {
    start: bounds.start,
    end: bounds.end,
    localStartDate: priorMonday,
    localEndDate: priorSunday
  };
}

export function priorMonthlyBounds(period, timeZoneValue) {
  const timeZone = normalizeTimeZone(timeZoneValue).timeZone;
  const priorKey = priorMonthKeyFromPeriod(period);
  if (!priorKey) return null;
  const bounds = timeZoneMonthBounds(priorKey, timeZone);
  const [year, month] = priorKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: bounds.start,
    end: bounds.end,
    localStartDate: `${priorKey}-01`,
    localEndDate: `${priorKey}-${pad2(lastDay)}`,
    periodKey: priorKey
  };
}

function priorMonthKeyFromPeriod(period) {
  const key = String(period?.periodKey ?? "");
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return null;
  let year = Number(match[1]);
  let month = Number(match[2]) - 1;
  if (month < 1) {
    month = 12;
    year -= 1;
  }
  return `${year}-${pad2(month)}`;
}

function localWeekStartKey(period, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(period.periodStartUtc);
  const values = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDayKey(dayKey, deltaDays) {
  const [year, month, day] = String(dayKey).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

export function isoWeekKeyForLocalDate(year, month, day) {  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((date - yearStart) / 86_400_000) + 1) / 7);
  return `${isoYear}-W${pad2(week)}`;
}

function isInsideSendWindow(now, timeZone) {
  const hour = localHour(now, timeZone);
  return hour >= SEND_START_HOUR && hour < SEND_END_HOUR;
}

function zonedDateParts(date, timeZone) {
  const values = {};
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day
  };
}

function zonedDateTimeParts(date, timeZone) {
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
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second
  };
}

function zonedTimeToUtc(year, month, day, hour, timeZone) {
  const targetMs = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
  let guessMs = targetMs;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = zonedDateTimeParts(new Date(guessMs), timeZone);
    const actualMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
    const delta = targetMs - actualMs;
    if (delta === 0) break;
    guessMs += delta;
  }
  return new Date(guessMs);
}

function addLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function formatLocalDate(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}
