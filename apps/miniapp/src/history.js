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

function parseYmd(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}
