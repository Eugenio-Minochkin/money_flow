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

export function buildHistoryAnalytics(expenses, categoryLimit = 5) {
  if (!expenses.length) return { total: 0, count: 0, categories: [], topExpenses: [] };
  const total = periodTotal(expenses);
  const categoryTotals = new Map();
  for (const expense of expenses) {
    const slug = expense.category_slug || "other";
    categoryTotals.set(slug, (categoryTotals.get(slug) ?? 0) + Number(expense.amount_base ?? 0));
  }
  const storedOther = categoryTotals.get("other") ?? 0;
  const sorted = [...categoryTotals.entries()]
    .filter(([category_slug]) => category_slug !== "other")
    .map(([category_slug, amount]) => ({ category_slug, amount }))
    .sort((left, right) => right.amount - left.amount);
  const categories = sorted.slice(0, categoryLimit);
  const remainder = storedOther + sorted.slice(categoryLimit).reduce((sum, item) => sum + item.amount, 0);
  if (remainder > 0) categories.push({ category_slug: "other", amount: remainder });
  for (const item of categories) {
    item.share = total > 0 ? Math.round((item.amount / total) * 10_000) / 100 : 0;
  }
  return {
    total,
    count: expenses.length,
    categories,
    topExpenses: [...expenses]
      .sort((left, right) => Number(right.amount_base ?? 0) - Number(left.amount_base ?? 0))
      .slice(0, 3)
  };
}

export function historySummaryKey(search) {
  return String(search ?? "").trim() ? "history.total.filtered" : null;
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
  return `${format(from)} \u2014 ${format(to)}`;
}

export function historyFilterFromLaunchParams(params) {
  const fallback = { period: "month", monthKey: "", fromDate: "", toDate: "" };
  if (params?.get("view") !== "history") return fallback;
  const period = params.get("period");
  const fromDate = params.get("fromDate");
  const toDate = params.get("toDate");
  if (!isValidRange(fromDate, toDate)) return fallback;
  if (period === "custom") {
    return { period: "custom", monthKey: "", fromDate, toDate };
  }
  const monthKey = params.get("monthKey");
  if (period === "month" && parseYm(monthKey) && fromDate.startsWith(`${monthKey}-`) && toDate.startsWith(`${monthKey}-`)) {
    return { period: "month", monthKey, fromDate, toDate };
  }
  return fallback;
}

export function buildHistoryRequestParams(telegramUserId, search, filter) {
  const params = new URLSearchParams({ telegramUserId: String(telegramUserId), search: String(search ?? "") });
  if (isValidRange(filter?.fromDate, filter?.toDate)) {
    params.set("fromDate", filter.fromDate);
    params.set("toDate", filter.toDate);
  } else {
    params.set("period", filter?.period || "month");
  }
  return params;
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

export function createCalendarDraft(filter, today) {
  const currentMonth = String(today ?? "").slice(0, 7);
  if (
    filter?.period === "custom"
    && parseYmd(filter.fromDate)
    && parseYmd(filter.toDate)
  ) {
    return {
      startDate: filter.fromDate,
      endDate: filter.toDate,
      selectionComplete: filter.fromDate !== filter.toDate,
      visibleMonth: filter.fromDate.slice(0, 7)
    };
  }
  return {
    startDate: "",
    endDate: "",
    selectionComplete: false,
    visibleMonth: parseYm(currentMonth) ? currentMonth : ""
  };
}

function parseYmd(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime()) || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function parseYm(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

function isValidRange(fromDate, toDate) {
  return Boolean(parseYmd(fromDate) && parseYmd(toDate) && compareYmd(fromDate, toDate) <= 0);
}
