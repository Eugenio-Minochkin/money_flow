export function groupByDay(expenses) {
  const groups = new Map();
  for (const expense of expenses) {
    const label = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "long" }).format(new Date(expense.spent_at));
    if (!groups.has(label)) groups.set(label, { label, total: 0, items: [] });
    const group = groups.get(label);
    group.total += Number(expense.amount_base ?? expense.amount_original);
    group.items.push(expense);
  }
  return [...groups.values()];
}

export function periodTotal(expenses) {
  return expenses.reduce((sum, expense) => sum + Number(expense.amount_base ?? 0), 0);
}

export function expenseCountLabel(count, language = "ru") {
  const n = Math.abs(Number(count) || 0);
  if (language === "en") {
    if (n === 0) return "No expenses";
    if (n === 1) return "1 expense";
    return `${n} expenses`;
  }
  if (n === 0) return "Расходов нет";
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} расход`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} расхода`;
  return `${n} расходов`;
}

export function formatCustomRangeLabel(fromDate, toDate, language = "ru") {
  const from = parseYmd(fromDate);
  const to = parseYmd(toDate);
  if (!from || !to) return "";
  const locale = language === "en" ? "en-US" : "ru-RU";
  const monthStyle = language === "en" ? "short" : "long";
  const format = (date) => new Intl.DateTimeFormat(locale, { day: "numeric", month: monthStyle }).format(date);
  if (String(fromDate) === String(toDate)) return format(from);
  return `${format(from)}\u2013${format(to)}`;
}

export function selectRangeDate(state = {}, date) {
  if (!parseYmd(date)) return { ...state };
  if (!state.startDate || state.selectionComplete) {
    return { startDate: date, endDate: date, selectionComplete: false };
  }
  const [startDate, endDate] = compareYmd(date, state.startDate) < 0
    ? [date, state.startDate]
    : [state.startDate, date];
  return { startDate, endDate, selectionComplete: true };
}

export function compareYmd(left, right) {
  if (!parseYmd(left) || !parseYmd(right)) return 0;
  return String(left).localeCompare(String(right));
}

export function isFutureYmd(value, today) {
  if (!parseYmd(value) || !parseYmd(today)) return false;
  return compareYmd(value, today) > 0;
}

export function buildCalendarMonth(month, today, range = {}) {
  const parsedMonth = parseYm(month);
  if (!parsedMonth) return [];
  const daysInMonth = new Date(parsedMonth.year, parsedMonth.month, 0).getDate();
  return Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const date = `${month}-${String(day).padStart(2, "0")}`;
    const weekdayIndex = (new Date(parsedMonth.year, parsedMonth.month - 1, day).getDay() + 6) % 7;
    const isStart = date === range.startDate;
    const isEnd = date === range.endDate;
    return {
      date,
      day,
      weekdayIndex,
      disabled: isFutureYmd(date, today),
      isStart,
      isEnd,
      isInRange: Boolean(
        range.startDate
        && range.endDate
        && compareYmd(date, range.startDate) >= 0
        && compareYmd(date, range.endDate) <= 0
        && !isStart
        && !isEnd
      )
    };
  });
}

export function shiftCalendarMonth(month, delta) {
  const parsed = parseYm(month);
  if (!parsed || !Number.isInteger(delta)) return month;
  const date = new Date(parsed.year, parsed.month - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function canNavigateToMonth(month, today) {
  const parsed = parseYm(month);
  const todayDate = parseYmd(today);
  if (!parsed || !todayDate) return false;
  const currentMonth = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, "0")}`;
  return month <= currentMonth;
}

function parseYmd(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseYm(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}
