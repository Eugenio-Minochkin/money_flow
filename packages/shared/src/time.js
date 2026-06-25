const DEFAULT_OFFSET_MINUTES = 7 * 60;
export const DEFAULT_TIMEZONE = "Asia/Bangkok";

export function normalizeTimeZone(value, fallback = DEFAULT_TIMEZONE) {
  if (value == null || String(value).trim() === "") {
    return { timeZone: fallback, fallback: true, reason: "timezone_missing" };
  }
  const timeZone = String(value).trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return { timeZone, fallback: false, reason: null };
  } catch {
    return { timeZone: fallback, fallback: true, reason: "timezone_invalid" };
  }
}

export function resolveUserTimeZone(user) {
  return normalizeTimeZone(user?.timezone).timeZone;
}

export function timeZoneMonthKey(date, timeZone = "UTC") {
  const parts = timeZoneDateParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}`;
}

export function timeZoneDayKey(date, timeZone = "UTC") {
  const parts = timeZoneDateParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

export function timeZoneDayBounds(date, timeZone = "UTC") {
  const zone = timeZoneValue(timeZone, "UTC");
  const parts = timeZoneDateParts(date, zone);
  return {
    start: zonedTimeToUtc(parts.year, parts.month, parts.day, 0, zone),
    end: zonedTimeToUtc(...Object.values(nextCalendarDay(parts)), 0, zone)
  };
}

export function timeZoneMonthState(date, timeZone = "UTC") {
  const parts = timeZoneDateParts(date, timeZone);
  const daysInMonth = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
  return {
    period: `${parts.year}-${pad2(parts.month)}`,
    dayOfMonth: parts.day,
    daysInMonth,
    remainingDays: daysInMonth - parts.day + 1
  };
}

export function timeZoneMonthBounds(period, timeZone = "UTC") {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period));
  if (!match) throw new Error(`Invalid month period: ${period}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`Invalid month period: ${period}`);
  const zone = timeZoneValue(timeZone, "UTC");
  return {
    start: zonedTimeToUtc(year, month, 1, 0, zone),
    end: zonedTimeToUtc(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1, 0, zone)
  };
}

export function toOffsetIso(date, offsetMinutes = DEFAULT_OFFSET_MINUTES) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  const base = shifted.toISOString().replace("Z", "");
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const minutes = String(abs % 60).padStart(2, "0");
  return `${base}${sign}${hours}:${minutes}`;
}

export function toZonedIso(date, timeZone = DEFAULT_TIMEZONE) {
  const zone = timeZoneValue(timeZone, DEFAULT_TIMEZONE);
  const parts = zonedParts(date, zone);
  const offsetMinutes = timeZoneOffsetMinutes(date, zone);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const minutes = String(abs % 60).padStart(2, "0");
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}.000${sign}${hours}:${minutes}`;
}

export function monthDaysLeft(date, offsetMinutes = DEFAULT_OFFSET_MINUTES) {
  if (typeof offsetMinutes !== "number") {
    const timeZone = timeZoneValue(offsetMinutes, DEFAULT_TIMEZONE);
    const day = localMonthDay(date, timeZone);
    const daysInMonth = daysInLocalMonth(date, timeZone);
    return Math.max(daysInMonth - day + 1, 1);
  }
  const local = new Date(date.getTime() + offsetMinutes * 60_000);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const day = local.getUTCDate();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Math.max(daysInMonth - day + 1, 1);
}

export function localPeriodBounds(date, period, offsetMinutes = DEFAULT_OFFSET_MINUTES) {
  if (typeof offsetMinutes !== "number") {
    return localPeriodBoundsForTimeZone(date, period, offsetMinutes);
  }
  const local = new Date(date.getTime() + offsetMinutes * 60_000);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const day = local.getUTCDate();

  let startLocal;
  let endLocal;

  if (period === "today") {
    startLocal = Date.UTC(year, month, day, 0, 0, 0, 0);
    endLocal = Date.UTC(year, month, day + 1, 0, 0, 0, 0);
  } else if (period === "yesterday") {
    startLocal = Date.UTC(year, month, day - 1, 0, 0, 0, 0);
    endLocal = Date.UTC(year, month, day, 0, 0, 0, 0);
  } else if (period === "last7") {
    startLocal = Date.UTC(year, month, day - 6, 0, 0, 0, 0);
    endLocal = Date.UTC(year, month, day + 1, 0, 0, 0, 0);
  } else if (period === "week") {
    const dayOfWeek = local.getUTCDay();
    const daysFromMonday = (dayOfWeek + 6) % 7;
    startLocal = Date.UTC(year, month, day - daysFromMonday, 0, 0, 0, 0);
    endLocal = Date.UTC(year, month, day + 1, 0, 0, 0, 0);
  } else if (period === "month") {
    startLocal = Date.UTC(year, month, 1, 0, 0, 0, 0);
    endLocal = Date.UTC(year, month + 1, 1, 0, 0, 0, 0);
  } else if (period === "previous_month") {
    startLocal = Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
    endLocal = Date.UTC(year, month, 1, 0, 0, 0, 0);
  } else {
    throw new Error(`Unsupported period: ${period}`);
  }

  return {
    start: new Date(startLocal - offsetMinutes * 60_000),
    end: new Date(endLocal - offsetMinutes * 60_000)
  };
}

export function localDateRangeBounds(fromDate, toDate, offsetMinutes = DEFAULT_OFFSET_MINUTES) {
  const from = parseDateParts(fromDate);
  const to = parseDateParts(toDate);
  if (!from || !to || from.ms > to.ms) return null;

  if (typeof offsetMinutes !== "number") {
    const timeZone = timeZoneValue(offsetMinutes, DEFAULT_TIMEZONE);
    return {
      start: zonedTimeToUtc(from.year, from.month + 1, from.day, 0, timeZone),
      end: zonedTimeToUtc(to.year, to.month + 1, to.day + 1, 0, timeZone)
    };
  }

  const startLocal = Date.UTC(from.year, from.month, from.day, 0, 0, 0, 0);
  const endLocal = Date.UTC(to.year, to.month, to.day + 1, 0, 0, 0, 0);

  return {
    start: new Date(startLocal - offsetMinutes * 60_000),
    end: new Date(endLocal - offsetMinutes * 60_000)
  };
}

export function localDateKey(date, timeZone = DEFAULT_TIMEZONE) {
  const parts = zonedParts(date, timeZoneValue(timeZone, DEFAULT_TIMEZONE));
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

export function localMonthKey(date, timeZone = DEFAULT_TIMEZONE) {
  const parts = zonedParts(date, timeZoneValue(timeZone, DEFAULT_TIMEZONE));
  return `${parts.year}-${pad2(parts.month)}`;
}

export function localHour(date, timeZone = DEFAULT_TIMEZONE) {
  return zonedParts(date, timeZoneValue(timeZone, DEFAULT_TIMEZONE)).hour;
}

export function localWeekday(date, timeZone = DEFAULT_TIMEZONE) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZoneValue(timeZone, DEFAULT_TIMEZONE),
    weekday: "short"
  }).format(date);
  return { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[weekday] ?? 1;
}

export function daysInLocalMonth(date, timeZone = DEFAULT_TIMEZONE) {
  const parts = zonedParts(date, timeZoneValue(timeZone, DEFAULT_TIMEZONE));
  return new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
}

export function localMonthDay(date, timeZone = DEFAULT_TIMEZONE) {
  return zonedParts(date, timeZoneValue(timeZone, DEFAULT_TIMEZONE)).day;
}

function localPeriodBoundsForTimeZone(date, period, inputTimeZone) {
  const timeZone = timeZoneValue(inputTimeZone, DEFAULT_TIMEZONE);
  const parts = zonedParts(date, timeZone);
  let start;
  let end;

  if (period === "today") {
    start = { year: parts.year, month: parts.month, day: parts.day };
    end = addLocalDays(start, 1);
  } else if (period === "yesterday") {
    start = addLocalDays({ year: parts.year, month: parts.month, day: parts.day }, -1);
    end = { year: parts.year, month: parts.month, day: parts.day };
  } else if (period === "last7") {
    start = addLocalDays({ year: parts.year, month: parts.month, day: parts.day }, -6);
    end = addLocalDays({ year: parts.year, month: parts.month, day: parts.day }, 1);
  } else if (period === "week") {
    const weekday = localWeekday(date, timeZone);
    start = addLocalDays({ year: parts.year, month: parts.month, day: parts.day }, -(weekday - 1));
    end = addLocalDays({ year: parts.year, month: parts.month, day: parts.day }, 1);
  } else if (period === "month") {
    start = { year: parts.year, month: parts.month, day: 1 };
    end = parts.month === 12
      ? { year: parts.year + 1, month: 1, day: 1 }
      : { year: parts.year, month: parts.month + 1, day: 1 };
  } else if (period === "previous_month") {
    const previous = parts.month === 1
      ? { year: parts.year - 1, month: 12 }
      : { year: parts.year, month: parts.month - 1 };
    start = { ...previous, day: 1 };
    end = { year: parts.year, month: parts.month, day: 1 };
  } else {
    throw new Error(`Unsupported period: ${period}`);
  }

  return {
    start: zonedTimeToUtc(start.year, start.month, start.day, 0, timeZone),
    end: zonedTimeToUtc(end.year, end.month, end.day, 0, timeZone)
  };
}

function zonedParts(date, timeZone) {
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

function timeZoneDateParts(date, timeZone) {
  const values = {};
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZoneValue(timeZone, "UTC"),
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

function timeZoneOffsetMinutes(date, timeZone) {
  const shortOffset = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset"
  }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
  if (!shortOffset || shortOffset === "GMT") return 0;
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(shortOffset);
  if (!match) return DEFAULT_OFFSET_MINUTES;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

function zonedTimeToUtc(year, month, day, hour, timeZone) {
  const targetMs = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
  let guessMs = targetMs;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = zonedParts(new Date(guessMs), timeZone);
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

function nextCalendarDay(parts) {
  return addLocalDays(parts, 1);
}

function timeZoneValue(value, fallback) {
  if (value && typeof value === "object" && typeof value.timeZone === "string") return value.timeZone;
  return normalizeTimeZone(value, fallback).timeZone;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function parseDateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  return { year, month, day, ms: Date.UTC(year, month, day) };
}
