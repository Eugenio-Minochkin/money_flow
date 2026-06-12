export const ZERO_DECIMAL_DISPLAY_CURRENCIES = ["THB", "RUB", "IDR", "BYN"];
export const TWO_DECIMAL_DISPLAY_CURRENCIES = ["USD", "EUR", "GEL"];

let baseCurrency = "THB";

export function setBaseCurrency(currency = "THB") {
  baseCurrency = currency || "THB";
}

export function formatMoney(amount, currency = baseCurrency, options = {}) {
  const normalizedCurrency = normalizeCurrency(currency);
  const formattedAmount = formatMoneyAmount(amount, normalizedCurrency, options);
  const prefix = options.prefix ?? "";
  const suffix = options.suffix ?? (options.includeCurrency === false ? "" : ` ${normalizedCurrency}`);
  return `${prefix}${formattedAmount}${suffix}`;
}

export function moneyBase(value, currency = baseCurrency) {
  return formatMoney(value, currency);
}

export function moneyDisplay(value, currency = "USD") {
  if (value == null || Number.isNaN(Number(value))) return "";
  const normalizedCurrency = normalizeCurrency(currency);
  const symbols = {
    USD: "$",
    EUR: "\u20ac",
    IDR: "Rp ",
    GEL: "\u20be",
    BYN: "Br ",
    RUB: ""
  };
  const hasSymbol = Object.hasOwn(symbols, normalizedCurrency) && symbols[normalizedCurrency];
  const prefix = hasSymbol ? `~${symbols[normalizedCurrency]}` : "";
  const suffix = hasSymbol ? "" : ` ${normalizedCurrency}`;
  return formatMoney(value, normalizedCurrency, { prefix, suffix });
}

export function moneyDisplaySigned(value, currency = "USD") {
  if (value == null || Number.isNaN(Number(value))) return "";
  const sign = Number(value) > 0 ? "+" : "";
  return `${sign}${moneyDisplay(value, currency)}`;
}

export function formatDate(value, language = "ru") {
  return new Intl.DateTimeFormat(localeFor(language), {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Bangkok"
  }).format(new Date(value));
}

export function formatDateOnly(value, language = "ru") {
  return new Intl.DateTimeFormat(localeFor(language), {
    day: "2-digit",
    month: "short",
    timeZone: "Asia/Bangkok"
  }).format(new Date(value));
}

function localeFor(language) {
  return language === "en" ? "en-US" : "ru-RU";
}

function formatMoneyAmount(amount, currency, options = {}) {
  const decimals = displayDecimalsForCurrency(currency);
  const numeric = safeMoneyNumber(amount);
  const displayValue = decimals === 0 ? Math.round(numeric) : numeric;
  return new Intl.NumberFormat(options.locale ?? "ru-RU", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(displayValue);
}

function displayDecimalsForCurrency(currency) {
  if (ZERO_DECIMAL_DISPLAY_CURRENCIES.includes(currency)) return 0;
  if (TWO_DECIMAL_DISPLAY_CURRENCIES.includes(currency)) return 2;
  return 2;
}

function safeMoneyNumber(amount) {
  const numeric = Number(amount ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function normalizeCurrency(currency) {
  return String(currency || baseCurrency || "THB").toUpperCase();
}

export function dateTimeLocal(value) {
  const date = new Date(value ?? Date.now());
  return new Date(date.getTime() + 7 * 60 * 60_000).toISOString().slice(0, 16);
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("\n", " ");
}
