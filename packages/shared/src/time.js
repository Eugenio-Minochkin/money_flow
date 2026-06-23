const DEFAULT_OFFSET_MINUTES = 7 * 60;

export function normalizeTimeZone(value) {
  const candidate = String(value ?? "").trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return "UTC";
  }
}

export function timeZoneMonthKey(date, timeZone = "UTC") {
  const parts = timeZoneDateParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}`;
}

export function timeZoneMonthState(date, timeZone = "UTC") {
  const parts = timeZoneDateParts(date, timeZone);
  const daysInMonth = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
  return {
    period: `${parts.year}-${String(parts.month).padStart(2, "0")}`,
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
  return {
    start: zonedDateTimeToUtc({ year, month, day: 1 }, timeZone),
    end: zonedDateTimeToUtc({
      year: month === 12 ? year + 1 : year,
      month: month === 12 ? 1 : month + 1,
      day: 1
    }, timeZone)
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

export function monthDaysLeft(date, offsetMinutes = DEFAULT_OFFSET_MINUTES) {
  const local = new Date(date.getTime() + offsetMinutes * 60_000);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const day = local.getUTCDate();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Math.max(daysInMonth - day + 1, 1);
}

export function localPeriodBounds(date, period, offsetMinutes = DEFAULT_OFFSET_MINUTES) {
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

  const startLocal = Date.UTC(from.year, from.month, from.day, 0, 0, 0, 0);
  const endLocal = Date.UTC(to.year, to.month, to.day + 1, 0, 0, 0, 0);

  return {
    start: new Date(startLocal - offsetMinutes * 60_000),
    end: new Date(endLocal - offsetMinutes * 60_000)
  };
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

function timeZoneDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: normalizeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const values = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day)
  };
}

function zonedDateTimeToUtc({ year, month, day }, timeZone) {
  const zone = normalizeTimeZone(timeZone);
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = timeZoneOffsetMs(new Date(guess), zone);
    const next = target - offset;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

function timeZoneOffsetMs(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const values = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  const representedAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );
  return representedAsUtc - date.getTime();
}
