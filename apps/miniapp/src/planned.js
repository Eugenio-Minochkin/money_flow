export function nextPlannedItem(items, now = new Date()) {
  return items
    .map((item) => ({ item, date: nextPlannedDate(item, now) }))
    .filter((entry) => entry.date)
    .sort((left, right) => left.date - right.date)[0] ?? null;
}

export function nextPlannedDate(item, now = new Date()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const candidates = [];
  const addCandidate = (date) => {
    if (!date) return;
    date.setHours(0, 0, 0, 0);
    if (date >= today) candidates.push(date);
  };

  if (item.recurrence === "one_off" && item.due_date) {
    addCandidate(new Date(item.due_date));
  } else if (item.recurrence === "weekly") {
    const target = Number(item.weekday ?? 1);
    const current = today.getDay() === 0 ? 7 : today.getDay();
    const daysUntil = (target - current + 7) % 7;
    const date = new Date(today);
    date.setDate(today.getDate() + daysUntil);
    addCandidate(date);
  } else {
    const days = Array.isArray(item.due_days) && item.due_days.length ? item.due_days : [item.due_day].filter(Boolean);
    for (const day of days.map(Number)) {
      const date = new Date(today.getFullYear(), today.getMonth(), day);
      addCandidate(date);
      if (date < today) addCandidate(new Date(today.getFullYear(), today.getMonth() + 1, day));
    }
  }

  return candidates.sort((left, right) => left - right)[0] ?? null;
}

export function isDueToday(item, today = new Date()) {
  if (item.recurrence === "one_off" && item.due_date) {
    return new Date(item.due_date).toDateString() === today.toDateString();
  }
  if (item.recurrence === "weekly") {
    const weekday = today.getDay() === 0 ? 7 : today.getDay();
    return Number(item.weekday) === weekday;
  }
  const days = Array.isArray(item.due_days) && item.due_days.length ? item.due_days : [item.due_day];
  return days.map(Number).includes(today.getDate());
}

export function isPlannedPaid(item) {
  return Number(item.paid_count ?? (item.paid_month ? 1 : 0)) > 0;
}

export function parseDueDays(value) {
  return String(value ?? "")
    .split(",")
    .map((day) => Number(day.trim()))
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 31);
}

export function recurrenceLabel(item, formatDate) {
  const recurrence = typeof item === "string" ? item : item.recurrence;
  if (recurrence === "weekly") return `каждый ${weekdayName(item.weekday)}`;
  if (recurrence === "twice_monthly") {
    const days = Array.isArray(item.due_days) && item.due_days.length ? item.due_days : [item.due_day].filter(Boolean);
    return days.length ? `${days.join(" и ")} числа` : "2 раза в месяц";
  }
  if (recurrence === "monthly") return item.due_day ? `${item.due_day} числа` : "раз в месяц";
  if (recurrence === "one_off") return item.due_date ? formatDate(item.due_date) : "один раз";
  return recurrence;
}

export function weekdayOptions(selected, option) {
  return [1, 2, 3, 4, 5, 6, 7]
    .map((weekday) => option(String(weekday), String(selected ?? 1), weekdayName(weekday)))
    .join("");
}

export function weekdayName(weekday) {
  return {
    1: "понедельник",
    2: "вторник",
    3: "среду",
    4: "четверг",
    5: "пятницу",
    6: "субботу",
    7: "воскресенье"
  }[Number(weekday)] ?? "понедельник";
}
