export function plannedOccurrenceDateKeysForPeriod(item, period) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period ?? ""));
  if (!match) return [];

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || month < 1 || month > 12) return [];

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const recurrence = item?.recurrence === "one_time" ? "one_off" : item?.recurrence;
  let keys = [];

  if (recurrence === "weekly") {
    const target = normalizeWeekday(item?.weekday);
    for (let day = 1; day <= daysInMonth; day += 1) {
      const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
      if (weekday === target) keys.push(dateKey(year, month, day));
    }
  } else if (recurrence === "one_off") {
    const dueDate = normalizePlannedDateKey(item?.due_date);
    if (dueDate?.slice(0, 7) === period) keys = [dueDate];
  } else {
    const rawDays = Array.isArray(item?.due_days) && item.due_days.length
      ? item.due_days
      : [item?.due_day ?? 1];
    const days = [...new Set(rawDays
      .map(Number)
      .filter((day) => Number.isInteger(day) && day >= 1)
      .map((day) => Math.min(day, daysInMonth)))]
      .sort((left, right) => left - right);
    keys = days.map((day) => dateKey(year, month, day));
  }

  const startsOn = normalizePlannedDateKey(item?.starts_on);
  return startsOn ? keys.filter((key) => key >= startsOn) : keys;
}

export function normalizePlannedDateKey(value) {
  if (value == null || value === "") return null;

  const raw = value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === day
    ? dateKey(year, month, day)
    : null;
}

function normalizeWeekday(value) {
  const weekday = Number(value);
  return Number.isInteger(weekday) && weekday >= 1 && weekday <= 7 ? weekday : 1;
}

function dateKey(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
