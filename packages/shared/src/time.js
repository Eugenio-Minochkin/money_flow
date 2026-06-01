const DEFAULT_OFFSET_MINUTES = 7 * 60;

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
  } else if (period === "month") {
    startLocal = Date.UTC(year, month, 1, 0, 0, 0, 0);
    endLocal = Date.UTC(year, month + 1, 1, 0, 0, 0, 0);
  } else {
    throw new Error(`Unsupported period: ${period}`);
  }

  return {
    start: new Date(startLocal - offsetMinutes * 60_000),
    end: new Date(endLocal - offsetMinutes * 60_000)
  };
}
