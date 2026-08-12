const CURRENCY_SYMBOLS = new Map([
  ["$", "USD"],
  ["€", "EUR"],
  ["₽", "RUB"],
  ["฿", "THB"]
]);
const ZERO_DECIMAL_DISPLAY_CURRENCIES = new Set(["THB", "RUB", "IDR", "BYN"]);

export function parseAmountSearch(query) {
  const compact = String(query ?? "").trim().replace(/^~/, "").replace(/[\s\u00a0\u202f]+/g, "");
  const match = /^([a-zA-Z]{3}|[$€₽฿])?([+-]?\d+(?:[.,]\d{1,2})?)([a-zA-Z]{3}|[$€₽฿])?$/.exec(compact);
  if (!match) return null;
  const amount = Number(match[2].replace(",", "."));
  if (!Number.isFinite(amount)) return null;
  const prefixCurrency = normalizeCurrencyToken(match[1]);
  const suffixCurrency = normalizeCurrencyToken(match[3]);
  if (prefixCurrency && suffixCurrency && prefixCurrency !== suffixCurrency) return null;
  return { amount, currency: prefixCurrency ?? suffixCurrency };
}

export function matchesExpenseSearch(expense, query) {
  const amountSearch = parseAmountSearch(query);
  if (!amountSearch) return matchesText(expense, query);
  if (matchesText(expense, query)) return true;
  const candidates = [
    [expense.amount_original, expense.currency_original],
    [expense.amount_base, expense.base_currency],
    [expense.display?.amount, expense.display?.currency]
  ];
  return candidates.some(([amount, currency]) => (
    Number.isFinite(Number(amount))
    && moneyUnits(amount, currency) === moneyUnits(amountSearch.amount, currency)
    && (!amountSearch.currency || String(currency ?? "").toUpperCase() === amountSearch.currency)
  ));
}

function moneyUnits(amount, currency) {
  const factor = ZERO_DECIMAL_DISPLAY_CURRENCIES.has(String(currency ?? "").toUpperCase()) ? 1 : 100;
  return Math.round(Number(amount) * factor);
}

function matchesText(expense, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return true;
  return [expense.description, expense.category_slug, ...(expense.tags ?? [])]
    .some((value) => String(value ?? "").toLowerCase().includes(needle));
}

function normalizeCurrencyToken(token) {
  if (!token) return null;
  return CURRENCY_SYMBOLS.get(token) ?? token.toUpperCase();
}
