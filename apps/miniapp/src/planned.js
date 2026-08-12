export function nextPlannedItem(items, now = new Date()) {
  return items
    .map((item) => ({ item, date: nextPlannedDate(item, now) }))
    .filter((entry) => entry.date)
    .sort((left, right) => left.date - right.date)[0] ?? null;
}

export function calculatePlannedMonthSummary(items, now = new Date()) {
  const summary = {
    total: 0,
    paid: 0,
    remaining: 0,
    display: {
      total: 0,
      paid: 0,
      remaining: 0,
      currency: null
    }
  };

  for (const item of items.filter((planned) => planned.active !== false)) {
    const occurrences = buildPlannedOccurrences(item, now);
    const occurrenceCount = occurrences.length;
    if (!occurrenceCount) continue;

    const paidCount = paidOccurrenceCount(item, occurrences, now);
    const remainingCount = occurrenceCount - paidCount;
    const amountBase = Number(item.amount_base ?? item.amount ?? 0);
    const displayAmount = Number(item.display?.amount ?? 0);

    summary.total += amountBase * occurrenceCount;
    summary.paid += amountBase * paidCount;
    summary.remaining += amountBase * remainingCount;

    if (item.display?.currency) summary.display.currency = item.display.currency;
    summary.display.total += displayAmount * occurrenceCount;
    summary.display.paid += displayAmount * paidCount;
    summary.display.remaining += displayAmount * remainingCount;
  }

  summary.total = roundMoney(summary.total);
  summary.paid = roundMoney(summary.paid);
  summary.remaining = roundMoney(summary.remaining);
  summary.display.total = roundMoney(summary.display.total);
  summary.display.paid = roundMoney(summary.display.paid);
  summary.display.remaining = roundMoney(summary.display.remaining);

  return summary;
}

export function plannedPaidPercent(summary = {}) {
  const total = Number(summary.total ?? 0);
  const paid = Number(summary.paid ?? 0);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(paid)) return 0;
  return Math.min(100, Math.max(0, Math.round((paid / total) * 100)));
}

export function defaultPlannedCurrency(item = {}, baseCurrency = "THB") {
  return item.currency || baseCurrency || "THB";
}

export function nextUnpaidPlannedItem(items, now = new Date()) {
  const todayKey = dateKey(now);
  return items
    .filter((item) => item.active !== false)
    .flatMap((item) => buildPlannedOccurrences(item, now)
      .filter((occurrence) => !occurrence.paid)
      .map((occurrence) => ({ item, date: parseDateKey(occurrence.occurrence_date), occurrence })))
    .sort((left, right) => occurrenceSortValue(left.occurrence.occurrence_date, todayKey) - occurrenceSortValue(right.occurrence.occurrence_date, todayKey))[0] ?? null;
}

export function dueOrOverduePlannedOccurrences(items, now = new Date()) {
  const todayKey = dateKey(now);
  const entries = items
    .filter((item) => item.active !== false)
    .flatMap((item) => buildPlannedOccurrences(item, now)
      .filter((occurrence) => !occurrence.paid && occurrence.occurrence_date <= todayKey)
      .map((occurrence) => ({
        item,
        occurrence,
        date: parseDateKey(occurrence.occurrence_date),
        isToday: occurrence.occurrence_date === todayKey
      })));
  return entries.sort((left, right) => {
    if (left.isToday !== right.isToday) return left.isToday ? 1 : -1;
    const byDate = left.occurrence.occurrence_date.localeCompare(right.occurrence.occurrence_date);
    if (byDate !== 0) return byDate;
    const leftDesc = String(left.item.description ?? "");
    const rightDesc = String(right.item.description ?? "");
    if (leftDesc !== rightDesc) return leftDesc.localeCompare(rightDesc);
    return String(left.item.id ?? "").localeCompare(String(right.item.id ?? ""));
  });
}

export function nextPlannedDate(item, now = new Date()) {
  const todayKey = dateKey(now);
  const thisMonth = buildPlannedOccurrences(item, now)
    .filter((occurrence) => occurrence.occurrence_date >= todayKey);
  if (thisMonth.length) return parseDateKey(thisMonth[0].occurrence_date);
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return buildPlannedOccurrences(item, nextMonth)
    .map((occurrence) => parseDateKey(occurrence.occurrence_date))[0] ?? null;
}

export function isDueToday(item, today = new Date()) {
  if ((item.recurrence === "one_off" || item.recurrence === "one_time") && item.due_date) {
    return new Date(item.due_date).toDateString() === today.toDateString();
  }
  if (item.recurrence === "weekly") {
    const weekday = today.getDay() === 0 ? 7 : today.getDay();
    return Number(item.weekday) === weekday;
  }
  const days = Array.isArray(item.due_days) && item.due_days.length ? item.due_days : [item.due_day];
  return days.map(Number).includes(today.getDate());
}

export function isPlannedPaid(item, now = new Date()) {
  const occurrences = buildPlannedOccurrences(item, now);
  if (!occurrences.length) return Number(item.paid_count ?? (item.paid_month ? 1 : 0)) > 0;
  return occurrences.length > 0 && paidOccurrenceCount(item, occurrences) >= occurrences.length;
}

export function plannedOccurrencesThisMonth(item, now = new Date()) {
  return buildPlannedOccurrences(item, now).length;
}

export function buildPlannedOccurrences(item, now = new Date()) {
  if (item.active === false) return [];
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const dates = [];

  if (item.recurrence === "one_off" || item.recurrence === "one_time") {
    if (!item.due_date) return [];
    const dueDate = new Date(item.due_date);
    if (dueDate.getFullYear() === year && dueDate.getMonth() === month) dates.push(dateKey(dueDate));
  } else if (item.recurrence === "weekly") {
    const target = Number(item.weekday ?? 1);
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = new Date(year, month, day);
      const weekday = date.getDay() === 0 ? 7 : date.getDay();
      if (weekday === target) dates.push(dateKey(date));
    }
  } else {
    const days = Array.isArray(item.due_days) && item.due_days.length ? item.due_days : [item.due_day].filter(Boolean);
    const clampedDays = [...new Set(days
      .map(Number)
      .filter((day) => Number.isInteger(day) && day >= 1)
      .map((day) => Math.min(day, daysInMonth)))]
      .sort((left, right) => left - right);
    dates.push(...clampedDays.map((day) => dateKey(new Date(year, month, day))));
  }

  const startsOn = /^\d{4}-\d{2}-\d{2}$/.test(String(item.starts_on ?? "")) ? String(item.starts_on) : null;
  const eligibleDates = startsOn ? dates.filter((key) => key >= startsOn) : dates;
  const paidDates = new Set(item.paid_occurrence_dates ?? item.paidOccurrences ?? []);
  const paidMap = item.paid_occurrences && typeof item.paid_occurrences === "object" ? item.paid_occurrences : null;
  const legacyPaidCount = Math.min(Number(item.paid_count ?? (item.paid_month ? 1 : 0)), eligibleDates.length);
  return eligibleDates.map((occurrenceDate, index) => {
    const paidEntry = paidMap ? paidMap[occurrenceDate] : null;
    const paid = paidMap
      ? Boolean(paidEntry && paidEntry.expense_id)
      : (paidDates.has(occurrenceDate) || (!paidDates.size && index < legacyPaidCount));
    return {
      planned_payment_id: item.id,
      occurrence_date: occurrenceDate,
      amount: Number(item.amount ?? item.amount_base ?? 0),
      currency: item.currency,
      paid,
      paid_at: paidEntry?.paid_at ?? item.paid_occurrences?.[occurrenceDate]?.paid_at ?? null,
      expense_id: paidEntry?.expense_id ?? item.paid_occurrences?.[occurrenceDate]?.expense_id ?? null
    };
  });
}

export function parseDueDays(value) {
  return String(value ?? "")
    .split(",")
    .map((day) => Number(day.trim()))
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 31);
}

export function recurrenceLabel(item, formatDate, language = "ru") {
  const recurrence = typeof item === "string" ? item : item.recurrence;
  if (recurrence === "weekly") return language === "en" ? `every ${weekdayName(item.weekday, language)}` : `каждый ${weekdayName(item.weekday, language)}`;
  if (recurrence === "twice_monthly") {
    const days = Array.isArray(item.due_days) && item.due_days.length ? item.due_days : [item.due_day].filter(Boolean);
    if (language === "en") return days.length ? `${days.join(" and ")} day` : "twice a month";
    return days.length ? `${days.join(" и ")} числа` : "2 раза в месяц";
  }
  if (recurrence === "monthly") return item.due_day ? (language === "en" ? `day ${item.due_day}` : `${item.due_day} числа`) : (language === "en" ? "monthly" : "раз в месяц");
  if (recurrence === "one_off" || recurrence === "one_time") return item.due_date ? formatDate(item.due_date) : (language === "en" ? "one-off" : "один раз");
  return recurrence;
}

export function weekdayOptions(selected, option, language = "ru") {
  return [1, 2, 3, 4, 5, 6, 7]
    .map((weekday) => option(String(weekday), String(selected ?? 1), weekdayName(weekday, language)))
    .join("");
}

export function weekdayName(weekday, language = "ru") {
  const ru = {
    1: "понедельник",
    2: "вторник",
    3: "среду",
    4: "четверг",
    5: "пятницу",
    6: "субботу",
    7: "воскресенье"
  };
  const en = {
    1: "Monday",
    2: "Tuesday",
    3: "Wednesday",
    4: "Thursday",
    5: "Friday",
    6: "Saturday",
    7: "Sunday"
  };
  const labels = language === "en" ? en : ru;
  return labels[Number(weekday)] ?? labels[1];
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function paidOccurrenceCount(item, occurrences, now = new Date()) {
  return occurrences.filter((occurrence) => occurrence.paid).length;
}

function occurrenceSortValue(occurrenceDate, todayKey) {
  const date = parseDateKey(occurrenceDate).getTime();
  return occurrenceDate <= todayKey ? date : date + 100_000_000_000_000;
}

function dateKey(date) {
  const value = new Date(date);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(value) {
  const [year, month, day] = String(value).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function monthKey(now) {
  const value = new Date(now);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;
}
